import process from 'node:process';

type BooleanArgDefinition = {
	type: 'boolean';
	short?: string;
	description?: string;
	default?: boolean;
	negatable?: boolean;
	hidden?: boolean;
	toKebab?: boolean;
};

type StringArgDefinition = {
	type: 'string';
	short?: string;
	description?: string;
	default?: string;
	hidden?: boolean;
	toKebab?: boolean;
};

type NumberArgDefinition = {
	type: 'number';
	short?: string;
	description?: string;
	default?: number;
	hidden?: boolean;
	toKebab?: boolean;
};

type EnumArgDefinition = {
	type: 'enum';
	short?: string;
	description?: string;
	choices: readonly string[];
	default?: string;
	hidden?: boolean;
	toKebab?: boolean;
};

type CustomArgDefinition = {
	type: 'custom';
	short?: string;
	description?: string;
	parse: (value: string) => unknown;
	default?: unknown;
	hidden?: boolean;
	toKebab?: boolean;
};

type ArgDefinition =
	| BooleanArgDefinition
	| StringArgDefinition
	| NumberArgDefinition
	| EnumArgDefinition
	| CustomArgDefinition;

export type Args = Record<string, ArgDefinition>;

type ValueFromArg<TArg> = TArg extends { type: 'boolean' }
	? boolean
	: TArg extends { type: 'string' }
		? string | undefined
		: TArg extends { type: 'number' }
			? number
			: TArg extends { type: 'enum'; choices: readonly (infer Choice extends string)[] }
				? Choice
				: TArg extends { type: 'custom'; parse: (value: string) => infer Parsed }
					? Parsed
					: unknown;

type Values<TArgs extends Args> = {
	[K in keyof TArgs]: ValueFromArg<TArgs[K]>;
};

type OptionToken = {
	kind: 'option';
	name: string;
};

type CommandContext<TArgs extends Args> = {
	name: string;
	values: Values<TArgs>;
	tokens: OptionToken[];
};

export type Command<TArgs extends Args = Args> = {
	name: string;
	description: string;
	args: TArgs;
	toKebab?: boolean;
	run: (ctx: CommandContext<TArgs>) => Promise<void> | void;
};

type CliOptions = {
	name: string;
	version: string;
	description: string;
	subCommands: Map<string, Command>;
};

type ParseResult<TArgs extends Args> = {
	values: Values<TArgs>;
	tokens: OptionToken[];
};

type LongNameMap = {
	longToKey: Map<string, string>;
	keyToLong: Map<string, string>;
};

export function define<TArgs extends Args>(command: Command<TArgs>): Command<TArgs> {
	return command;
}

function toKebabCase(value: string): string {
	return value.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
}

function isKebabEnabled(command: Command, arg: ArgDefinition): boolean {
	return command.toKebab === true || arg.toKebab === true;
}

function buildLongNameMap(command: Command): LongNameMap {
	const longToKey = new Map<string, string>();
	const keyToLong = new Map<string, string>();

	for (const [key, arg] of Object.entries(command.args)) {
		longToKey.set(key, key);
		let preferredName = key;

		if (isKebabEnabled(command, arg)) {
			const kebab = toKebabCase(key);
			longToKey.set(kebab, key);
			preferredName = kebab;
		}

		keyToLong.set(key, preferredName);
	}

	return {
		longToKey,
		keyToLong,
	};
}

function printGlobalHelp(mainCommand: Command, options: CliOptions): void {
	console.log(`${options.name} v${options.version}`);
	console.log(options.description);
	console.log('');
	console.log('Usage:');
	console.log(`  ${options.name} [command] [options]`);
	console.log('');
	console.log('Commands:');
	for (const command of options.subCommands.values()) {
		console.log(`  ${command.name.padEnd(10)} ${command.description}`);
	}
	console.log('');
	console.log(`Run "${options.name} ${mainCommand.name} --help" for command options.`);
}

function printCommandHelp(command: Command, cliName: string): void {
	const { keyToLong } = buildLongNameMap(command);

	console.log('Usage:');
	console.log(`  ${cliName} ${command.name} [options]`);
	console.log('');
	console.log(command.description);
	console.log('');
	console.log('Options:');

	for (const [key, arg] of Object.entries(command.args)) {
		if (arg.hidden === true) {
			continue;
		}

		const longName = keyToLong.get(key) ?? key;
		const short = arg.short != null ? `-${arg.short}, ` : '';
		const long =
			arg.type === 'boolean' ? `--${longName}` : `--${longName} <${arg.type === 'number' ? 'number' : 'value'}>`;
		const negatable = arg.type === 'boolean' && arg.negatable === true ? `, --no-${longName}` : '';
		const choices =
			arg.type === 'enum' && arg.choices.length > 0
				? ` (choices: ${arg.choices.join(', ')})`
				: '';
		const defaultValue = arg.default !== undefined ? ` (default: ${String(arg.default)})` : '';

		console.log(`  ${short}${long}${negatable}`);
		if (arg.description != null && arg.description !== '') {
			console.log(`      ${arg.description}${choices}${defaultValue}`);
		} else if (choices !== '' || defaultValue !== '') {
			console.log(`      ${(choices + defaultValue).trim()}`);
		}
	}

	console.log('  -h, --help');
	console.log('      Show help');
}

function initValues<TArgs extends Args>(command: Command<TArgs>): Values<TArgs> {
	const values = {} as Values<TArgs>;

	for (const [key, arg] of Object.entries(command.args)) {
		if (arg.type === 'boolean') {
			(values as Record<string, unknown>)[key] = arg.default ?? false;
			continue;
		}

		if (arg.type === 'string') {
			(values as Record<string, unknown>)[key] = typeof arg.default === 'string' ? arg.default : undefined;
			continue;
		}

		if (arg.type === 'number') {
			(values as Record<string, unknown>)[key] = typeof arg.default === 'number' ? arg.default : 0;
			continue;
		}

		if (arg.type === 'enum') {
			const fallback = arg.choices[0];
			(values as Record<string, unknown>)[key] = arg.default ?? fallback;
			continue;
		}

		(values as Record<string, unknown>)[key] = arg.default;
	}

	return values;
}

function buildShortArgMap(args: Args): Map<string, string> {
	const shortMap = new Map<string, string>();
	for (const [key, arg] of Object.entries(args)) {
		if (arg.short != null) {
			shortMap.set(arg.short, key);
		}
	}
	return shortMap;
}

function parseNumberValue(raw: string, optionName: string): number {
	const parsed = Number(raw);
	if (!Number.isFinite(parsed)) {
		throw new Error(`Invalid number for --${optionName}: ${raw}`);
	}
	return parsed;
}

function canBeNegativeNumberToken(token: string): boolean {
	return /^-\d+(\.\d+)?$/u.test(token);
}

function resolveRawValue(
	arg: ArgDefinition,
	inlineValue: string | undefined,
	nextToken: string | undefined,
	optionName: string,
): string | undefined {
	if (arg.type === 'boolean') {
		return undefined;
	}

	if (inlineValue != null) {
		return inlineValue;
	}

	if (nextToken == null) {
		throw new Error(`Missing value for --${optionName}`);
	}

	if (nextToken.startsWith('-')) {
		if (arg.type === 'number' && canBeNegativeNumberToken(nextToken)) {
			return nextToken;
		}
		throw new Error(`Missing value for --${optionName}`);
	}

	return nextToken;
}

function parseOptionValue(
	arg: ArgDefinition,
	rawValue: string | undefined,
	optionName: string,
): unknown {
	if (arg.type === 'boolean') {
		return true;
	}

	if (rawValue == null) {
		throw new Error(`Missing value for --${optionName}`);
	}

	if (arg.type === 'string') {
		return rawValue;
	}

	if (arg.type === 'number') {
		return parseNumberValue(rawValue, optionName);
	}

	if (arg.type === 'enum') {
		if (!arg.choices.includes(rawValue)) {
			throw new Error(
				`Invalid value for --${optionName}: ${rawValue}. Expected one of: ${arg.choices.join(', ')}`,
			);
		}
		return rawValue;
	}

	return arg.parse(rawValue);
}

function parseValues<TArgs extends Args>(command: Command<TArgs>, argv: string[]): ParseResult<TArgs> {
	const values = initValues(command);
	const tokens: OptionToken[] = [];
	const shortMap = buildShortArgMap(command.args);
	const { longToKey, keyToLong } = buildLongNameMap(command);

	for (let i = 0; i < argv.length; i++) {
		const token = argv[i] ?? '';
		if (token === '--') {
			break;
		}

		if (!token.startsWith('-')) {
			throw new Error(`Unknown argument: ${token}`);
		}

		if (token.startsWith('--')) {
			const raw = token.slice(2);
			const [namePart, inlineValue] = raw.split('=', 2);
			if (namePart == null || namePart === '') {
				throw new Error(`Invalid option: ${token}`);
			}

			if (namePart === 'help') {
				throw new Error('__help__');
			}

			const directKey = longToKey.get(namePart);
			if (directKey != null) {
				const arg = command.args[directKey];
				if (arg == null) {
					throw new Error(`Unknown option: --${namePart}`);
				}

				const optionName = keyToLong.get(directKey) ?? directKey;
				const rawValue = resolveRawValue(arg, inlineValue, argv[i + 1], optionName);
				const value = parseOptionValue(arg, rawValue, optionName);
				(values as Record<string, unknown>)[directKey] = value;
				tokens.push({ kind: 'option', name: directKey });

				if (arg.type !== 'boolean' && inlineValue == null) {
					i++;
				}
				continue;
			}

			if (namePart.startsWith('no-')) {
				const positiveName = namePart.slice(3);
				const key = longToKey.get(positiveName);
				const arg = key != null ? command.args[key] : undefined;

				if (key == null || arg == null || arg.type !== 'boolean' || arg.negatable !== true) {
					throw new Error(`Unknown option: --${namePart}`);
				}

				(values as Record<string, unknown>)[key] = false;
				tokens.push({ kind: 'option', name: key });
				continue;
			}

			throw new Error(`Unknown option: --${namePart}`);
		}

		const shortFlags = token.slice(1).split('');
		for (let j = 0; j < shortFlags.length; j++) {
			const flag = shortFlags[j] ?? '';
			if (flag === 'h') {
				throw new Error('__help__');
			}

			const key = shortMap.get(flag);
			if (key == null) {
				throw new Error(`Unknown option: -${flag}`);
			}

			const arg = command.args[key];
			if (arg == null) {
				throw new Error(`Unknown option: -${flag}`);
			}

			if (arg.type === 'boolean') {
				(values as Record<string, unknown>)[key] = true;
				tokens.push({ kind: 'option', name: key });
				continue;
			}

			const rest = shortFlags.slice(j + 1).join('');
			const optionName = keyToLong.get(key) ?? key;
			const rawValue = resolveRawValue(
				arg,
				rest !== '' ? rest : undefined,
				rest === '' ? argv[i + 1] : undefined,
				optionName,
			);
			const value = parseOptionValue(arg, rawValue, optionName);

			(values as Record<string, unknown>)[key] = value;
			tokens.push({ kind: 'option', name: key });

			if (rest === '') {
				i++;
			}
			break;
		}
	}

	return {
		values,
		tokens,
	};
}

export async function cli(
	argv: string[],
	mainCommand: Command,
	options: CliOptions,
): Promise<void> {
	const first = argv[0];

	if (first === '--version' || first === '-v') {
		console.log(options.version);
		return;
	}

	if (first === '--help' || first === '-h') {
		printGlobalHelp(mainCommand, options);
		return;
	}

	let command = mainCommand;
	let commandArgs = argv;

	if (first != null && options.subCommands.has(first)) {
		command = options.subCommands.get(first) ?? mainCommand;
		commandArgs = argv.slice(1);
	}

	if (commandArgs[0] === '--help' || commandArgs[0] === '-h') {
		printCommandHelp(command, options.name);
		return;
	}

	try {
		const parsed = parseValues(command, commandArgs);
		await command.run({
			name: command.name,
			values: parsed.values,
			tokens: parsed.tokens,
		});
	} catch (error) {
		if (error instanceof Error && error.message === '__help__') {
			printCommandHelp(command, options.name);
			return;
		}

		const message = error instanceof Error ? error.message : String(error);
		console.error(message);
		process.exit(1);
	}
}
