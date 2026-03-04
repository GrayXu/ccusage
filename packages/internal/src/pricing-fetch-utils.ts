import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import type { LiteLLMModelPricing } from './pricing.ts';
import * as v from 'valibot';
import { LITELLM_PRICING_URL, liteLLMModelPricingSchema } from './pricing.ts';

export type PricingDataset = Record<string, LiteLLMModelPricing>;

export function createPricingDataset(): PricingDataset {
	return Object.create(null) as PricingDataset;
}

const MAX_HTTP_REDIRECTS = 5;
const HTTP_REQUEST_TIMEOUT_MS = 10_000;
const HTTPS_PROXY_ENV_KEYS = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy'] as const;
const HTTP_PROXY_ENV_KEYS = ['HTTP_PROXY', 'http_proxy'] as const;
const NO_PROXY_ENV_KEYS = ['NO_PROXY', 'no_proxy'] as const;

type NoProxyRule = {
	host: string;
	port?: string;
	wildcard: boolean;
};

function readEnv(keys: readonly string[]): string | undefined {
	for (const key of keys) {
		const value = process.env[key]?.trim();
		if (value != null && value !== '') {
			return value;
		}
	}

	return undefined;
}

function defaultPort(protocol: string): string {
	return protocol === 'https:' ? '443' : '80';
}

function parseNoProxyRule(entry: string): NoProxyRule | null {
	const value = entry.trim().toLowerCase();
	if (value === '' || value === '*') {
		return value === '*' ? { host: '*', wildcard: true } : null;
	}

	let hostPort = value;
	let port: string | undefined;

	if (hostPort.includes('://')) {
		try {
			const parsed = new URL(hostPort);
			hostPort = parsed.hostname.toLowerCase();
			port = parsed.port || undefined;
		} catch {
			return null;
		}
	} else if (hostPort.startsWith('[') && hostPort.includes(']')) {
		const end = hostPort.indexOf(']');
		const host = hostPort.slice(1, end);
		const rest = hostPort.slice(end + 1);
		if (rest.startsWith(':') && /^\d+$/.test(rest.slice(1))) {
			port = rest.slice(1);
		}
		hostPort = host;
	} else {
		const maybePortIndex = hostPort.lastIndexOf(':');
		if (maybePortIndex > -1) {
			const maybePort = hostPort.slice(maybePortIndex + 1);
			if (/^\d+$/.test(maybePort)) {
				port = maybePort;
				hostPort = hostPort.slice(0, maybePortIndex);
			}
		}
	}

	const wildcard = hostPort.startsWith('.');
	const host = wildcard ? hostPort.slice(1) : hostPort;
	if (host === '') {
		return null;
	}

	return { host, port, wildcard };
}

function isNoProxyMatch(targetUrl: URL): boolean {
	const noProxy = readEnv(NO_PROXY_ENV_KEYS);
	if (noProxy == null) {
		return false;
	}

	const targetHost = targetUrl.hostname.toLowerCase();
	const targetPort = targetUrl.port || defaultPort(targetUrl.protocol);

	for (const part of noProxy.split(',')) {
		const rule = parseNoProxyRule(part);
		if (rule == null) {
			continue;
		}

		if (rule.host === '*') {
			return true;
		}

		if (rule.port != null && rule.port !== targetPort) {
			continue;
		}

		if (targetHost === rule.host || targetHost.endsWith(`.${rule.host}`)) {
			return true;
		}
		if (rule.wildcard && targetHost.endsWith(rule.host)) {
			return true;
		}
	}

	return false;
}

function resolveProxyUrl(targetUrl: URL): URL | null {
	if (isNoProxyMatch(targetUrl)) {
		return null;
	}

	const proxyValue = targetUrl.protocol === 'https:'
		? readEnv(HTTPS_PROXY_ENV_KEYS)
		: readEnv(HTTP_PROXY_ENV_KEYS);

	if (proxyValue == null) {
		return null;
	}

	try {
		const proxyUrl = new URL(proxyValue);
		if (proxyUrl.protocol !== 'http:' && proxyUrl.protocol !== 'https:') {
			return null;
		}
		return proxyUrl;
	} catch {
		return null;
	}
}

function proxyPort(proxyUrl: URL): number {
	return Number(proxyUrl.port || (proxyUrl.protocol === 'https:' ? 443 : 80));
}

function proxyAuthorization(proxyUrl: URL): string | undefined {
	if (proxyUrl.username === '' && proxyUrl.password === '') {
		return undefined;
	}

	const username = decodeURIComponent(proxyUrl.username);
	const password = decodeURIComponent(proxyUrl.password);
	return `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timeout = setTimeout(() => {
			reject(new Error(message));
		}, timeoutMs);

		promise.then(
			(value) => {
				clearTimeout(timeout);
				resolve(value);
			},
			(error) => {
				clearTimeout(timeout);
				reject(error);
			},
		);
	});
}

async function fetchDataset(url: string): Promise<Record<string, unknown>> {
	const requestUrl = new URL(url);
	const proxyUrl = resolveProxyUrl(requestUrl);

	if (proxyUrl == null && typeof globalThis.fetch === 'function') {
		const response = await withTimeout(
			fetch(url),
			HTTP_REQUEST_TIMEOUT_MS,
			`Failed to fetch pricing data: request timed out after ${HTTP_REQUEST_TIMEOUT_MS}ms`,
		);
		if (!response.ok) {
			throw new Error(`Failed to fetch pricing data: ${response.status} ${response.statusText}`);
		}
		return withTimeout(
			response.json() as Promise<Record<string, unknown>>,
			HTTP_REQUEST_TIMEOUT_MS,
			`Failed to parse pricing data: request timed out after ${HTTP_REQUEST_TIMEOUT_MS}ms`,
		);
	}

	return fetchDatasetWithHttp(url);
}

function fetchDatasetWithHttp(
	url: string,
	redirectCount: number = 0,
): Promise<Record<string, unknown>> {
	return new Promise((resolve, reject) => {
		const requestUrl = new URL(url);
		const selectedProxyUrl = resolveProxyUrl(requestUrl);
		const closeResponseSocket = (response: http.IncomingMessage): void => {
			response.socket.destroy();
		};

		const handleResponse = (response: http.IncomingMessage): void => {
			const statusCode = response.statusCode ?? 0;
			const statusText = response.statusMessage ?? `HTTP ${statusCode}`;

			if (
				statusCode >= 300 &&
				statusCode < 400 &&
				typeof response.headers.location === 'string'
			) {
				response.once('end', () => {
					closeResponseSocket(response);
				});
				response.resume();
				if (redirectCount >= MAX_HTTP_REDIRECTS) {
					reject(new Error(`Failed to fetch pricing data: too many redirects for ${url}`));
					return;
				}

				const nextUrl = new URL(response.headers.location, requestUrl).toString();
				fetchDatasetWithHttp(nextUrl, redirectCount + 1).then(resolve, reject);
				return;
			}

			if (statusCode < 200 || statusCode >= 300) {
				response.once('end', () => {
					closeResponseSocket(response);
				});
				response.resume();
				reject(new Error(`Failed to fetch pricing data: ${statusCode} ${statusText}`));
				return;
			}

			const chunks: string[] = [];
			response.setEncoding('utf8');
			response.on('data', (chunk) => chunks.push(chunk));
			response.on('end', () => {
				try {
					const parsed = JSON.parse(chunks.join('')) as unknown;
					if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
						reject(new Error('Failed to parse pricing data'));
						closeResponseSocket(response);
						return;
					}
					resolve(parsed as Record<string, unknown>);
					closeResponseSocket(response);
				} catch (error) {
					reject(new Error('Failed to parse pricing data', { cause: error }));
					closeResponseSocket(response);
				}
			});
		};

		const timeoutErrorMessage =
			`Failed to fetch pricing data: request timed out after ${HTTP_REQUEST_TIMEOUT_MS}ms`;

		const handleRequestError = (error: unknown): void => {
			reject(new Error('Failed to fetch pricing data', { cause: error }));
		};

		if (selectedProxyUrl != null && requestUrl.protocol === 'https:') {
			const transport = selectedProxyUrl.protocol === 'https:' ? https : http;
			const targetPort = Number(requestUrl.port || 443);
			const headers: Record<string, string> = {
				Host: `${requestUrl.hostname}:${targetPort}`,
				Connection: 'close',
				'Proxy-Connection': 'close',
			};
			const auth = proxyAuthorization(selectedProxyUrl);
			if (auth != null) {
				headers['Proxy-Authorization'] = auth;
			}

			const connectRequest = transport.request({
				host: selectedProxyUrl.hostname,
				port: proxyPort(selectedProxyUrl),
				method: 'CONNECT',
				path: `${requestUrl.hostname}:${targetPort}`,
				headers,
			});

			connectRequest.on('connect', (response, socket, head) => {
				const statusCode = response.statusCode ?? 0;
				if (statusCode < 200 || statusCode >= 300) {
					socket.destroy();
					reject(new Error(`Failed to establish proxy tunnel: HTTP ${statusCode}`));
					return;
				}

				if (head.length > 0) {
					socket.unshift(head);
				}

				const tlsSocket = tls.connect({
					socket,
					servername: requestUrl.hostname,
				});
				tlsSocket.on('error', handleRequestError);

				const tunneledRequest = https.request(
					{
						host: requestUrl.hostname,
						port: targetPort,
						method: 'GET',
						path: `${requestUrl.pathname}${requestUrl.search}`,
						headers: {
							Host: requestUrl.host,
							Connection: 'close',
						},
						agent: false,
						createConnection: () => tlsSocket,
					},
					handleResponse,
				);

				tunneledRequest.on('error', handleRequestError);
				tunneledRequest.setTimeout(HTTP_REQUEST_TIMEOUT_MS, () => {
					tunneledRequest.destroy(new Error(timeoutErrorMessage));
				});
				tunneledRequest.end();
			});

			connectRequest.on('error', handleRequestError);
			connectRequest.setTimeout(HTTP_REQUEST_TIMEOUT_MS, () => {
				connectRequest.destroy(new Error(timeoutErrorMessage));
			});
			connectRequest.end();
			return;
		}

		if (selectedProxyUrl != null) {
			const transport = selectedProxyUrl.protocol === 'https:' ? https : http;
			const headers: Record<string, string> = {
				Host: requestUrl.host,
				Connection: 'close',
				'Proxy-Connection': 'close',
			};
			const auth = proxyAuthorization(selectedProxyUrl);
			if (auth != null) {
				headers['Proxy-Authorization'] = auth;
			}

			const proxyRequest = transport.request(
				{
					host: selectedProxyUrl.hostname,
					port: proxyPort(selectedProxyUrl),
					method: 'GET',
					path: requestUrl.toString(),
					headers,
				},
				handleResponse,
			);
			proxyRequest.on('error', handleRequestError);
			proxyRequest.setTimeout(HTTP_REQUEST_TIMEOUT_MS, () => {
				proxyRequest.destroy(new Error(timeoutErrorMessage));
			});
			proxyRequest.end();
			return;
		}

		const transport = requestUrl.protocol === 'https:' ? https : http;
		const request = transport.get(requestUrl, handleResponse);
		request.on('error', handleRequestError);
		request.setTimeout(HTTP_REQUEST_TIMEOUT_MS, () => {
			request.destroy(new Error(timeoutErrorMessage));
		});
	});
}

export async function fetchLiteLLMPricingDataset(): Promise<PricingDataset> {
	const rawDataset = await fetchDataset(LITELLM_PRICING_URL);
	const dataset = createPricingDataset();

	for (const [modelName, modelData] of Object.entries(rawDataset)) {
		if (modelData == null || typeof modelData !== 'object') {
			continue;
		}

		const parsed = v.safeParse(liteLLMModelPricingSchema, modelData);
		if (!parsed.success) {
			continue;
		}

		dataset[modelName] = parsed.output;
	}

	return dataset;
}

export function filterPricingDataset(
	dataset: PricingDataset,
	predicate: (modelName: string, pricing: LiteLLMModelPricing) => boolean,
): PricingDataset {
	const filtered = createPricingDataset();
	for (const [modelName, pricing] of Object.entries(dataset)) {
		if (predicate(modelName, pricing)) {
			filtered[modelName] = pricing;
		}
	}
	return filtered;
}
