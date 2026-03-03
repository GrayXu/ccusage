import http from 'node:http';
import https from 'node:https';
import type { LiteLLMModelPricing } from './pricing.ts';
import * as v from 'valibot';
import { LITELLM_PRICING_URL, liteLLMModelPricingSchema } from './pricing.ts';

export type PricingDataset = Record<string, LiteLLMModelPricing>;

export function createPricingDataset(): PricingDataset {
	return Object.create(null) as PricingDataset;
}

const MAX_HTTP_REDIRECTS = 5;
const HTTP_REQUEST_TIMEOUT_MS = 10_000;

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
	if (typeof globalThis.fetch === 'function') {
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
		const transport = requestUrl.protocol === 'https:' ? https : http;

		const request = transport.get(requestUrl, (response) => {
			const statusCode = response.statusCode ?? 0;
			const statusText = response.statusMessage ?? `HTTP ${statusCode}`;

			if (
				statusCode >= 300 &&
				statusCode < 400 &&
				typeof response.headers.location === 'string'
			) {
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
						return;
					}
					resolve(parsed as Record<string, unknown>);
				} catch (error) {
					reject(new Error('Failed to parse pricing data', { cause: error }));
				}
			});
		});

		request.on('error', (error) => {
			reject(new Error('Failed to fetch pricing data', { cause: error }));
		});

		request.setTimeout(HTTP_REQUEST_TIMEOUT_MS, () => {
			request.destroy(
				new Error(
					`Failed to fetch pricing data: request timed out after ${HTTP_REQUEST_TIMEOUT_MS}ms`,
				),
			);
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
