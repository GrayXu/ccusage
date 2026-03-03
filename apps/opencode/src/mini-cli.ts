import process from "node:process";

type ArgType = "boolean" | "string";

type ArgDefinition = {
	type: ArgType;
	short?: string;
	description?: string;
	default?: boolean | string;
	negatable?: boolean;
};

export type Args = Record<string, ArgDefinition>;

type Values<TArgs extends Args> = {
	[K in keyof TArgs]: TArgs[K]["type"] extends "boolean" ? boolean : string | undefined;
};

type CommandContext<TArgs extends Args> = {
	name: string;
	values: Values<TArgs>;
};

export type Command<TArgs extends Args = Args> = {
	name: string;
	description: string;
	args: TArgs;
	run: (ctx: CommandContext<TArgs>) => Promise<void> | void;
};

type CliOptions = {
	name: string;
	version: string;
	description: string;
	subCommands: Map<string, Command>;
};

export function define<TArgs extends Args>(command: Command<TArgs>): Command<TArgs> {
	return command;
}

function printGlobalHelp(mainCommand: Command, options: CliOptions): void {
	console.log(`${options.name} v${options.version}`);
	console.log(options.description);
	console.log("");
	console.log("Usage:");
	console.log(`  ${options.name} [command] [options]`);
	console.log("");
	console.log("Commands:");
	for (const command of options.subCommands.values()) {
		console.log(`  ${command.name.padEnd(10)} ${command.description}`);
	}
	console.log("");
	console.log(`Run "${options.name} ${mainCommand.name} --help" for command options.`);
}

function printCommandHelp(command: Command, cliName: string): void {
	console.log("Usage:");
	console.log(`  ${cliName} ${command.name} [options]`);
	console.log("");
	console.log(command.description);
	console.log("");
	console.log("Options:");
	for (const [name, arg] of Object.entries(command.args)) {
		const short = arg.short != null ? `-${arg.short}, ` : "";
		const long = arg.type === "boolean" ? `--${name}` : `--${name} <value>`;
		const negatable = arg.negatable === true ? `, --no-${name}` : "";
		const defaultValue =
			arg.default !== undefined ? ` (default: ${String(arg.default)})` : "";
		console.log(`  ${short}${long}${negatable}`);
		if (arg.description != null && arg.description !== "") {
			console.log(`      ${arg.description}${defaultValue}`);
		} else if (defaultValue !== "") {
			console.log(`      ${defaultValue.trim()}`);
		}
	}
	console.log("  -h, --help");
	console.log("      Show help");
}

function initValues<TArgs extends Args>(args: TArgs): Values<TArgs> {
	const values = {} as Values<TArgs>;
	for (const [name, arg] of Object.entries(args)) {
		if (arg.type === "boolean") {
			(values as Record<string, unknown>)[name] = arg.default ?? false;
		} else {
			(values as Record<string, unknown>)[name] =
				typeof arg.default === "string" ? arg.default : undefined;
		}
	}
	return values;
}

function buildShortArgMap(args: Args): Map<string, string> {
	const shortMap = new Map<string, string>();
	for (const [name, arg] of Object.entries(args)) {
		if (arg.short != null) {
			shortMap.set(arg.short, name);
		}
	}
	return shortMap;
}

function parseValues<TArgs extends Args>(command: Command<TArgs>, argv: string[]): Values<TArgs> {
	const values = initValues(command.args);
	const args = command.args;
	const shortMap = buildShortArgMap(args);

	for (let i = 0; i < argv.length; i++) {
		const token = argv[i] ?? "";
		if (token === "--") {
			break;
		}

		if (!token.startsWith("-")) {
			throw new Error(`Unknown argument: ${token}`);
		}

		if (token.startsWith("--")) {
			const raw = token.slice(2);
			const [namePart, inlineValue] = raw.split("=", 2);
			if (namePart == null || namePart === "") {
				throw new Error(`Invalid option: ${token}`);
			}

			if (namePart === "help") {
				throw new Error("__help__");
			}

			if (namePart.startsWith("no-")) {
				const key = namePart.slice(3);
				const arg = args[key];
				if (arg == null || arg.type !== "boolean" || arg.negatable !== true) {
					throw new Error(`Unknown option: --${namePart}`);
				}
				(values as Record<string, unknown>)[key] = false;
				continue;
			}

			const arg = args[namePart];
			if (arg == null) {
				throw new Error(`Unknown option: --${namePart}`);
			}

			if (arg.type === "boolean") {
				(values as Record<string, unknown>)[namePart] = true;
				continue;
			}

			if (inlineValue != null) {
				(values as Record<string, unknown>)[namePart] = inlineValue;
				continue;
			}

			const next = argv[i + 1];
			if (next == null || next.startsWith("-")) {
				throw new Error(`Missing value for --${namePart}`);
			}
			(values as Record<string, unknown>)[namePart] = next;
			i++;
			continue;
		}

		const shortFlags = token.slice(1).split("");
		for (let j = 0; j < shortFlags.length; j++) {
			const flag = shortFlags[j] ?? "";
			if (flag === "h") {
				throw new Error("__help__");
			}

			const key = shortMap.get(flag);
			if (key == null) {
				throw new Error(`Unknown option: -${flag}`);
			}

			const arg = args[key];
			if (arg == null) {
				throw new Error(`Unknown option: -${flag}`);
			}

			if (arg.type === "boolean") {
				(values as Record<string, unknown>)[key] = true;
				continue;
			}

			const rest = shortFlags.slice(j + 1).join("");
			if (rest !== "") {
				(values as Record<string, unknown>)[key] = rest;
				break;
			}

			const next = argv[i + 1];
			if (next == null || next.startsWith("-")) {
				throw new Error(`Missing value for -${flag}`);
			}
			(values as Record<string, unknown>)[key] = next;
			i++;
			break;
		}
	}

	return values;
}

export async function cli(
	argv: string[],
	mainCommand: Command,
	options: CliOptions,
): Promise<void> {
	const first = argv[0];

	if (first === "--version" || first === "-v") {
		console.log(options.version);
		return;
	}

	if (first === "--help" || first === "-h") {
		printGlobalHelp(mainCommand, options);
		return;
	}

	let command = mainCommand;
	let commandArgs = argv;

	if (first != null && options.subCommands.has(first)) {
		command = options.subCommands.get(first) ?? mainCommand;
		commandArgs = argv.slice(1);
	}

	if (commandArgs[0] === "--help" || commandArgs[0] === "-h") {
		printCommandHelp(command, options.name);
		return;
	}

	try {
		const values = parseValues(command, commandArgs);
		await command.run({
			name: command.name,
			values,
		});
	} catch (error) {
		if (error instanceof Error && error.message === "__help__") {
			printCommandHelp(command, options.name);
			return;
		}

		const message = error instanceof Error ? error.message : String(error);
		console.error(message);
		process.exit(1);
	}
}
