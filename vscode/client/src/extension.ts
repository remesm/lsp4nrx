import * as path from 'path';
import * as net from 'net';
import * as fs from 'fs';
import {
    LanguageClient,
    ServerOptions,
    TransportKind,
    StreamInfo,
    LanguageClientOptions,
    RevealOutputChannelOn,
} from 'vscode-languageclient/node';

import {
    ExtensionContext,
    workspace,
    debug,
    DebugAdapterDescriptorFactory,
    DebugAdapterExecutable,
    DebugAdapterServer,
    DebugConfigurationProvider,
    DebugConfiguration,
    WorkspaceConfiguration,
    WorkspaceFolder,
    DebugSession,
    ProviderResult,
    DebugAdapterDescriptor,
    Uri,
    window,
    LogOutputChannel,
} from 'vscode';
import { abort } from 'process';


let client: LanguageClient;
let log: LogOutputChannel;

export function activate(context: ExtensionContext) {
    log = window.createOutputChannel(
        'NetRexx',
        { log: true }
    );

    context.subscriptions.push(log);

    log.info('NetRexx extension activated');
    // 1. LSP client
    client = startLanguageClient(context);

    // 2. Watch for Configuration Changes
    context.subscriptions.push(
        workspace.onDidChangeConfiguration(async (event) => {

            const restartLsp =
                event.affectsConfiguration('netrexx.lsp') ||
                event.affectsConfiguration('netrexx.cwd') ||
                event.affectsConfiguration('netrexx.classpath') ||
                event.affectsConfiguration('netrexx.log');

            if (!restartLsp) {
                return;
            }

            // An invalid/relative cwd is handled inside resolveWorkingDirectory
            // itself: it warns (non-modal) and falls back to the workspace
            // folder, so there is nothing to validate or revert here.
            const activeFile = getActiveNetRexxFile();
            const cwd = resolveWorkingDirectory(undefined, activeFile);
            
            const workspaceDir = getWorkspaceFolderPath(activeFile);
            const configuredClasspath = (getNetRexxConfig(activeFile).get<string>('classpath') || '').trim();

            const classpath = configuredClasspath
                ? resolveClasspathCandidate(
                    configuredClasspath,
                    workspaceDir,
                    'netrexx.classpath setting'
                )
                : undefined;

            log.info('LSP: configuration changed, cwd:', cwd);
            log.info('LSP: configuration changed, classpath:', classpath);
            log.info('LSP: Configuration changed. Restarting server...');

            if (client) {
                await client.stop();
            }

            client = startLanguageClient(context);

            log.info('NetRexx LSP: Server restarted.');
        })
    );

    // 3. DAP debug adapter
    context.subscriptions.push(
        debug.registerDebugAdapterDescriptorFactory('netrexx', new NetRexxDebugAdapterFactory(context))
    );

    // 4. DAP configuration
    context.subscriptions.push(
        debug.registerDebugConfigurationProvider(
            'netrexx',
            new NetRexxDebugConfigurationProvider()
        )
    );
}

// netrexx.* settings are workspace-scoped (see package.json:
// contributes.configuration - each property now uses "scope": "resource"),
// so we always read them through the resource they apply to rather than
// the unscoped, effectively-global workspace.getConfiguration(section).
function getScopedConfig(section: string, resource?: string): WorkspaceConfiguration {
    return workspace.getConfiguration(section, resource ? Uri.file(resource) : undefined);
}

function getNetRexxConfig(resource?: string): WorkspaceConfiguration {
    return getScopedConfig('netrexx', resource);
}

function resolveClasspathCandidate(
    rawValue: string,
    workspaceDir: string | undefined,
    sourceLabel: string
): string | undefined {

    const entries = rawValue
        .split(path.delimiter)
        .map((entry) => entry.trim())
        .filter((entry) => entry !== '');

    const resolvedEntries: string[] = [];

    for (const entry of entries) {
        const absolute = path.isAbsolute(entry)
            ? entry
            : (workspaceDir ? path.join(workspaceDir, entry) : entry);

        let valid = false;

        try {
            if (fs.existsSync(absolute)) {
                const stat = fs.statSync(absolute);

                valid =
                    stat.isDirectory() ||
                    (stat.isFile() && path.extname(absolute).toLowerCase() === '.jar');
            }
        } catch {
            valid = false;
        }

        if (!valid) {
            window.showWarningMessage(
                `NetRexx: ${sourceLabel} "${entry}" is not a valid directory or JAR file` +
                (workspaceDir ? ' - ignoring the configured classpath.' : '.')
            );

            return undefined;
        }

        resolvedEntries.push(absolute);
    }

    return resolvedEntries.join(path.delimiter);
}

function resolveJarAndClasspath(
    context: ExtensionContext,
    resource?: string
): { jar: string, classpath: string } {

    const config = getNetRexxConfig(resource);
    const configuredClasspath = (config.get<string>('classpath') || '').trim();

    const workspaceDir = getWorkspaceFolderPath(resource);

    const classpath = configuredClasspath
        ? resolveClasspathCandidate(
            configuredClasspath,
            workspaceDir,
            'netrexx.classpath setting'
        ) || ''
        : '';

    let jar = context.asAbsolutePath(path.join('lib', 'NetRexxC.jar'));

    if (classpath) {
        jar = classpath + path.delimiter + jar;
    }

    return { jar, classpath };
}

function getActiveNetRexxFile(): string | undefined {
    const file = window.activeTextEditor?.document.uri.fsPath;

    if (file && file.toLowerCase().endsWith('.nrx')) {
        return file;
    }

    return undefined;
}


// Splits an argument string into an array. Supports 'single' and "double" quotes.
function splitArguments(text: string): string[] {
    const result: string[] = [];
    let current = '';
    let quote: string | undefined;
    let started = false;

    for (const ch of text) {
        if (quote) {
            if (ch === quote) {
                quote = undefined;
            } else {
                current += ch;
            }
        } else if (ch === '"' || ch === "'") {
            quote = ch;
            started = true;
        } else if (/\s/.test(ch)) {
            if (started) {
                result.push(current);
                current = '';
                started = false;
            }
        } else {
            current += ch;
            started = true;
        }
    }

    if (started) {
        result.push(current);
    }

    return result;
}

function splitPrograms(program: string): string[] {
    const result: string[] = [];
    let current = '';
    let inQuote = false;

    for (let i = 0; i < program.length; i++) {
        const ch = program[i];

        if (ch === "'") {
            inQuote = !inQuote;
            continue;
        }

        if (/\s/.test(ch) && !inQuote) {
            if (current && !current.startsWith('-')) {
                result.push(current);
                current = '';
            }
            continue;
        }

        current += ch;
    }

    if (current && !current.startsWith('-')) {
        result.push(current);
    }

    return result;
}

function getUnsavedSources(program: string): string[] {
    const programs = splitPrograms(program);

    return programs.filter((file) => {
        const doc = workspace.textDocuments.find(
            (doc) => doc.uri.fsPath === file
        );

        return doc?.isDirty === true;
    });
}

function resolveProgram(session: DebugSession): string {
    // 1. Program/file from this DAP run configuration.
    //    Support both VS Code launch.json spellings.
    let program = typeof session.configuration.program === 'string'
        ? session.configuration.program.trim()
        : '';

    if (program === '') {
        program = typeof session.configuration.file === 'string'
            ? session.configuration.file.trim()
            : '';
    }

    // 2. Otherwise use the currently selected .nrx editor.
    if (program === '') {
        program = getActiveNetRexxFile() || '';
    }

    if (program === '') {
        throw new Error('No NetRexx program configured or selected');
    }

    const trimmed = program.trim();
    const lastWord = trimmed.split(/\s+/).pop();

    if (!trimmed.toLowerCase().endsWith('.nrx') && !lastWord?.startsWith('-')) {  // allow NetRexxC options
        throw new Error(`Program must be a .nrx file: ${program}`);
    }

    return program;
}

// Finds the workspace folder a cwd should be considered relative to.
// Prefers an explicit hint (VS Code already knows it for debug sessions
// and launch configs), then the folder owning the program file, then
// falls back to the first open workspace folder.
function getWorkspaceFolderPath(program?: string, workspaceFolderHint?: string): string | undefined {
    if (workspaceFolderHint) {
        return workspaceFolderHint;
    }

    if (program) {
        const folder = workspace.getWorkspaceFolder(Uri.file(program));
        if (folder) {
            return folder.uri.fsPath;
        }
    }

    return workspace.workspaceFolders?.[0]?.uri.fsPath;
}

// Resolves a single candidate cwd value: relative paths are resolved
// against the workspace folder (not the process cwd, and not the
// program's own directory). Invalid directories are never fatal - we
// warn (non-modal) and let the caller fall back to the next candidate.
function resolveCwdCandidate(rawValue: string, workspaceDir: string | undefined, sourceLabel: string): string | undefined {
    const absolute = path.isAbsolute(rawValue)
        ? rawValue
        : (workspaceDir ? path.join(workspaceDir, rawValue) : rawValue);

    if (fs.existsSync(absolute) && fs.statSync(absolute).isDirectory()) {
        return absolute;
    }

    window.showWarningMessage(
        `NetRexx: ${sourceLabel} "${rawValue}" is not a valid directory` +
        (workspaceDir ? ' - using the workspace folder instead.' : '.')
    );

    return undefined;
}

// Never throws: an invalid cwd anywhere in the chain is reported with a
// non-modal warning and skipped in favor of the next candidate.
function resolveWorkingDirectory(
    configuredCwd: string | undefined,
    program?: string,
    workspaceFolderHint?: string
): string | undefined {

    const workspaceDir = getWorkspaceFolderPath(program, workspaceFolderHint);

    // 1. Explicitly configured cwd (launch.json "cwd"/"file", or a
    //    DAP session's), resolved relative to the workspace folder.
    const configured = (configuredCwd || '').trim();
    if (configured) {
        const resolved = resolveCwdCandidate(configured, workspaceDir, 'configured "cwd"');
        if (resolved) {
            return resolved;
        }
    }

    // 2. netrexx.cwd setting, scoped to the program's workspace folder.
    const settingsCwd = (getNetRexxConfig(program).get<string>('cwd') || '').trim();
    if (settingsCwd) {
        const resolved = resolveCwdCandidate(settingsCwd, workspaceDir, 'netrexx.cwd setting');
        if (resolved) {
            return resolved;
        }
    }

    // 3. Workspace folder - the default when cwd is empty or invalid.
    if (workspaceDir) {
        return workspaceDir;
    }

    // 4. Program directory (single-file mode / no workspace open).
    if (program?.trim()) {
        return path.dirname(program);
    }

    return undefined;
}

class NetRexxDebugConfigurationProvider
    implements DebugConfigurationProvider {

    // Runs BEFORE ${file}/${workspaceFolder} substitution. This is only
    // for filling in a bare-bones config when the user starts debugging
    // with no launch.json at all - it must NOT read config.program for
    // validation, since at this point it can still be the literal,
    // unsubstituted string "${file}" rather than a real path.
    resolveDebugConfiguration(
        folder: WorkspaceFolder | undefined,
        config: DebugConfiguration
    ): ProviderResult<DebugConfiguration> {

        const dapconfig = getScopedConfig('netrexx.dap', folder?.uri.fsPath);
        const uiProgram = (dapconfig.get<string>('program') || '').trim();
        const uiArguments = (dapconfig.get<string>('arguments') || '').trim();

        if (!config.type && !config.request) {
            // No launch.json at all: the setting wins over the active file.
            config.type = 'netrexx';
            config.name = 'Debug NetRexx Program';
            config.request = 'launch';
            config.program = uiProgram || '${file}';
        } else if (uiProgram) {
            const currentProgram = typeof config.program === 'string' ? config.program.trim() : '';
            const currentFile = typeof config.file === 'string' ? config.file.trim() : '';

            // Empty or the stock "${file}" (= "whatever editor is active") counts as not filled in.
            if ((currentProgram === '' || currentProgram === '${file}') &&
                (currentFile === '' || currentFile === '${file}')) {
               config.program = uiProgram;
            }
        }

        // Arguments: launch.json "args" wins, otherwise the setting.
        const hasArgs =
            (Array.isArray(config.args) && config.args.length > 0) ||
            (typeof config.args === 'string' && config.args.trim() !== '');

        if (!hasArgs && uiArguments) {
            config.args = splitArguments(uiArguments);
        }

        return config;
    }
    // Runs AFTER ${file}/${workspaceFolder} substitution, so config.program
    // and config.cwd here are real, resolved paths - this is where actual
    // validation belongs.
    async resolveDebugConfigurationWithSubstitutedVariables(
        folder: WorkspaceFolder | undefined,
        config: DebugConfiguration
    ): Promise<DebugConfiguration | undefined> {

        try {
            let program =
                typeof config.program === 'string'
                    ? config.program.trim()
                    : '';

            if (!program) {
                program =
                    typeof config.file === 'string'
                        ? config.file.trim()
                        : '';
            }

            if (!program) {
                program = getActiveNetRexxFile() || '';
            }

            if (!program) {
                throw new Error('No NetRexx program configured or selected');
            }

            const trimmed = program.trim();
            const lastWord = trimmed.split(/\s+/).pop();

            if (!trimmed.toLowerCase().endsWith('.nrx') && !lastWord?.startsWith('-')) {  // allow NetRexxC options
   

//            if (!program.toLowerCase().endsWith('.nrx') && !program.trim().split(/\s+/).pop()?.startsWith('-')) {  // allow NetRexxC options
                throw new Error(`Program must be a .nrx file: ${program}`);
            }

            const unsaved = getUnsavedSources(program);

            if (unsaved.length > 0) {
                await window.showWarningMessage(
                'NetRexx: unsaved source files',
                {
                    modal: true,
                    detail:
                        'Save these files before debugging:\n\n' +
                        unsaved.join('\n')
                    }
                );

                return undefined;
            }

            const configuredCwd =
                typeof config.cwd === 'string' ? config.cwd : undefined;

            // An invalid/relative cwd is handled inside resolveWorkingDirectory:
            // it warns (non-modal) and falls back to the workspace folder.
            const cwd = resolveWorkingDirectory(configuredCwd, program, folder?.uri.fsPath);

            if (typeof config.args === 'string') {
                config.args = splitArguments(config.args);
            } else if (!Array.isArray(config.args)) {
                config.args = [];
            }

            config.program = program;
            if (cwd) {
                config.cwd = cwd;
            }

            return config;

        } catch (error) {
            // Only a genuinely missing/invalid program is fatal enough to
            // block the launch - there's no sensible fallback for that.
            const message =
                error instanceof Error
                    ? error.message
                    : String(error);
            await window.showErrorMessage(
                'Cannot start NetRexx debug session',
                {
                    modal: true,
                    detail: message
                }
            );

            return undefined;
        }
    }
}

class NetRexxDebugAdapterFactory implements DebugAdapterDescriptorFactory {
    constructor(private context: ExtensionContext) {}

    createDebugAdapterDescriptor(session: DebugSession): ProviderResult<DebugAdapterDescriptor> {

        let program;
        let cwd;
        try {
            program = resolveProgram(session);

            const configuredCwd =
                typeof session.configuration.cwd === 'string'
                    ? session.configuration.cwd
                    : undefined;

            // An invalid/relative cwd is handled inside resolveWorkingDirectory:
            // it warns (non-modal) and falls back to the workspace folder.
            cwd = resolveWorkingDirectory(configuredCwd, program, session.workspaceFolder?.uri.fsPath);
        } catch (error) {
            const message =
                error instanceof Error
                    ? error.message
                 : String(error);

            window.showErrorMessage(message);

            console.error('NETREXX DAP:', error);

            // Cancel starting the debug adapter.
            return undefined;
        }

        const config = getNetRexxConfig(program);
        const logStderr = config.get<boolean>('log', false);

        // Normalize the DAP launch parameters just like
        // NetRexxDapServerLauncher.getDapParameters().
        session.configuration.program = program;
        if (cwd) {
            session.configuration.cwd = cwd;
        }

        const lspconfig = getScopedConfig('netrexx.lsp', program);
        const onChange: string = lspconfig.get<string>('onChange') || '';   // intercept a possible --sock

        const dapconfig = getScopedConfig('netrexx.dap', program);
        const exposeInterpreter = dapconfig.get<boolean>('rx', false);
        const breakPerClause = dapconfig.get<boolean>('cl', false);

        log.info('DAP: createDebugAdapterDescriptor');
        log.info('DAP configuration:', session.configuration);
        log.info('DAP program:', program);
        log.info('DAP cwd:', cwd);
        log.info('DAP args:', session.configuration.args);

        if (onChange == '--sock') {
            const dapPort = 5006;
            const dapHost = '127.0.0.1';

            log.info('DAP: connecting to existing server at', dapHost + ':' + dapPort);

            return new DebugAdapterServer(dapPort, dapHost);
        }

        let { jar } = resolveJarAndClasspath(this.context, program);

        const args = ['-cp', jar, 'org.netrexx.lsp.NetRexxDapServer'];

        if (logStderr) {
            args.push('--log');
        }
        if (exposeInterpreter) {
            args.push('--rx')
        }
        if (breakPerClause) {
            args.push('--cl')
        }

        log.info('DAP command:', 'java', args);

        return new DebugAdapterExecutable(
            'java',
            args,
            cwd ? { cwd } : undefined
        );
    }
}


function startLanguageClient(context: ExtensionContext): LanguageClient {

    const activeFile = getActiveNetRexxFile();
    const config = getNetRexxConfig(activeFile);
    const logStderr = config.get<boolean>('log', false);

    // An invalid/relative cwd is handled inside resolveWorkingDirectory: it
    // warns (non-modal) and falls back to the workspace folder, using the
    // active .nrx editor's file as its program context.
    const cwd = resolveWorkingDirectory(undefined, activeFile);

    const lspconfig = getScopedConfig('netrexx.lsp', activeFile);
    const onChange: string = lspconfig.get<string>('onChange') || '';

    let { jar } = resolveJarAndClasspath(context, activeFile);

    let serverOptions: ServerOptions;

    // --- Socket Connection Mode ---
    if (onChange == '--sock') {
        const port = 5007;
        const host = '127.0.0.1';

        serverOptions = () => {
            const socket = net.connect({ port, host });
            const result: StreamInfo = { writer: socket, reader: socket };
            return Promise.resolve(result);
        };
    }


    const args = ['-cp', jar, 'org.netrexx.lsp.NetRexxLspServer'];

    if (onChange && onChange.trim() !== '') {
        args.push(onChange);
    }
    if (logStderr) {
        args.push("--log");
    }

    serverOptions = {
        command: 'java',
        args: args,
        transport: TransportKind.stdio,
        options: cwd ? { cwd } : undefined
    };

    const clientOptions: LanguageClientOptions = {
        documentSelector: [{ scheme: 'file', language: 'netrexx' }],
        revealOutputChannelOn: RevealOutputChannelOn.Info,
    };

    const newClient = new LanguageClient('nrxServer', 'NetRexx Server', serverOptions, clientOptions);
    newClient.start();

    return newClient;
}

export function deactivate(): Thenable<void> | undefined {
    if (!client) { return undefined; }
    return client.stop();
}
