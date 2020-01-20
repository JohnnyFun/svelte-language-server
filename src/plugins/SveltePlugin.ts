import cosmic from 'cosmiconfig';
import * as prettier from 'prettier';
import {
    DiagnosticsProvider,
    Document,
    Diagnostic,
    Range,
    DiagnosticSeverity,
    Fragment,
    Position,
    Host,
    FormattingProvider,
    TextEdit,
    CompletionList,
    CompletionItemKind,
    DefinitionLink,
    LocationLink,
} from '../api';
import { SvelteDocument } from '../lib/documents/SvelteDocument';
import { RawSourceMap, RawIndexMap, SourceMapConsumer } from 'source-map';
import { CompileOptions, Warning } from 'svelte/types/compiler/interfaces';
import { importSvelte, getSveltePackageInfo } from './svelte/sveltePackage';
import { PreprocessorGroup } from 'svelte/types/compiler/preprocess';
import path, { resolve, dirname } from 'path'
import fs from 'fs'
import { pathToUrl } from '../utils';
import ts from 'typescript';
import { TextDocument } from '../lib/documents/TextDocument';
import { convertRange, isSvelte } from './typescript/utils';

interface SvelteConfig extends CompileOptions {
    preprocess?: PreprocessorGroup;
}

const DEFAULT_OPTIONS: CompileOptions = {
    dev: true,
};

export class SveltePlugin implements DiagnosticsProvider, FormattingProvider {
    public pluginId = 'svelte';
    public defaultConfig = {
        enable: true,
        diagnostics: { enable: true },
        format: { enable: true },
    };

    private host!: Host;
    private basePaths: string[] | null = null
    private svelteFiles: string[] | null = null

    onRegister(host: Host) {
        this.host = host;
    }

    private hydrateSvelteFiles(document: Document) {
        // TODO: modify this.basePaths when any files are added/deleted
        const hydrated = this.svelteFiles !== null
        if (hydrated) return
        
        // hacky/incomplete implementation to get basic support for tsconfig/jsconfig module resolution
        // assumes that any given svelte component will be governed by the same tsconfig to keep this simple
        const docPath = document.getFilePath()

        // silently return if no doc path...doesn't seem like that would happen anyway
        if (docPath == null) return 
        const startPath = path.dirname(docPath) 
        this.basePaths = Array.from(getResolvedAliasPaths(startPath))
        this.svelteFiles = getAllSvelteOrHTMLFiles(this.basePaths)

        function getAllSvelteOrHTMLFiles(basePaths: string[]) : string[] {
            return Array.from(basePaths).map(base => {
                const allFiles = walkSync(base)
                const svelteFiles = allFiles.filter(f => ['.svelte', '.html'].some(ext => ext === path.extname(f).toLowerCase()))
                return svelteFiles
            }).reduce((a, b) => [...a, ...b], [])
        }

        function walkSync(dir: string, filelist: string[] = []) : string[] {
            fs.readdirSync(dir).forEach(file => {
                filelist = fs.statSync(path.join(dir, file)).isDirectory()
                ? walkSync(path.join(dir, file), filelist)
                : filelist.concat(path.join(dir, file));
            });
            return filelist;
        }
        function getResolvedAliasPaths(startDir: string) : Set<string> {
            let currentDir = startDir
            const possibleFileNames = ['tsconfig.json', 'jsconfig.json']
            while (currentDir !== '.') {
                for (let i = 0; i < possibleFileNames.length; i++) {
                    const name = possibleFileNames[i];
                    const candidate = path.join(currentDir, name)
                    if (fs.existsSync(candidate)) {
                        const config = fs.readFileSync(candidate, 'utf8')
                        const configPaths = parseOutPossibleBasePaths(currentDir, config)
                        return configPaths
                    }   
                }
                const newCurrentDir = path.dirname(currentDir);
                if (newCurrentDir === currentDir) {
                    break
                }
                currentDir = newCurrentDir
            }
            return new Set<string>()

            function parseOutPossibleBasePaths(currentDir: string, jsonConfig: string) : Set<string> {
                jsonConfig = jsonConfig.replace(/\/\*[^\*]*\*\/|\/\/.*/g, '') // get rid of comments
                const config = JSON.parse(jsonConfig)
                if (config.compilerOptions) {
                    const paths = config.compilerOptions.paths
                    if (paths != null) {
                        const basePaths = Object.keys(paths).map(pathKey => {
                            const basePaths = paths[pathKey].map((p:string) => {
                                // TODO: handle non-* paths
                                return path.resolve(currentDir, config.baseUrl || '.', p.replace(/\*$/, ''))
                            })
                            return basePaths
                        }).reduce((a,b) => [...a, ...b], [])
                        return new Set<string>(basePaths)
                    }
                }
                return new Set<string>()
            }
        }
    }

    getCompletions(document: Document, position: Position): CompletionList | null {
        if (!this.host.getConfig<boolean>('html.completions.enable')) {
            return null;
        }

        // const html = this.documents.get(document);
        // if (!html) {
        //     return null;
        // }

        // TODO: add results for possible svelte components and autoimport them if they're not already imported upon clicking...
        this.hydrateSvelteFiles(document)

        // const match = this.svelteFiles?.filter(f => this.isResolveMatch(f, ))

        let svelteResults: CompletionList = {
            isIncomplete: true,
            items: [
                {
                    label: "SomeSexyComponent",
                    documentation: "Will auto-import SomeSexyComponent if it's not already imported YAY!",
                    kind: CompletionItemKind.Text, // or Module, // or class?
                    textEdit: {    
                        newText: "SomeSexyComponent />",
                        range: {
                            start: { line: 100, character: 3 },
                            end: { line: 100, character: 3 }
                        }
                    },
                    additionalTextEdits: [{
                        newText: "import SomeSexyComponent from 'components/SomeSexyCompent.svelte'\n\t",
                        range: {
                            // would need to determine line of <script> or use vs-code helpers to find it?
                            start: { line: 104, character: 2 },
                            end: { line: 104, character: 2 }
                        }
                    }]
                }
            ]
        }

        const list = CompletionList.create([...svelteResults.items], true);
        return list
    }

    getDefinitions(document: Document, position: Position): DefinitionLink[] {
        if (!this.host.getConfig<boolean>('typescript.definitions.enable')) {
            return [];
        }
        this.hydrateSvelteFiles(document)
        const start = document.offsetAt(position)
        const docText = document.getText()
        const modulePath = getImportPathFromStart(docText, start)
        if (modulePath === null) return []
        const docDir = dirname(document.getFilePath()!)
        const matches = this.tryResolve(modulePath, docDir)
        const docs = new Map<string, Document>([[docDir, document]]);
        const range = {
            start,
            length: modulePath.length // should really highlight what they clicked on...whatever for now...
        }
        return matches
            .map(resolved => {
                let defDoc = docs.get(resolved);
                if (!defDoc) {
                    defDoc = new TextDocument(
                        pathToUrl(resolved),
                        ts.sys.readFile(resolved) || '',
                    );
                    docs.set(resolved, defDoc);
                }

                return LocationLink.create(
                    pathToUrl(resolved),
                    convertRange(defDoc, range),
                    convertRange(defDoc, range),
                    convertRange(document, range),
                );
            })
            .filter(res => !!res) as DefinitionLink[];
    }

    private tryResolve(modulePath: string, docDir: string) : string[] {
        if (this.svelteFiles === null || this.basePaths === null) return []
        const defaultSvelteExtension = '.svelte'
        const nameWithExt = isSvelte(modulePath) ? modulePath : modulePath + defaultSvelteExtension
        const relative = resolve(docDir, nameWithExt)
        const namesToCheck = [
            ...this.basePaths.map(base => resolve(docDir, base, nameWithExt)), // if aliased and found by tsconfig's file-finding algorithm
            relative // if relative
        ]
        const matches = this.svelteFiles.filter(f => namesToCheck.some(n => f.toLowerCase().endsWith(n.toLowerCase())))
        return matches
    }


    async getDiagnostics(document: Document): Promise<Diagnostic[]> {
        if (!this.host.getConfig<boolean>('svelte.diagnostics.enable')) {
            return [];
        }

        let source = document.getText();

        const config = await this.loadConfig(document.getFilePath()!);
        const svelte = importSvelte(document.getFilePath()!);

        const preprocessor = makePreprocessor(document as SvelteDocument, config.preprocess);
        source = (await svelte.preprocess(source, preprocessor, {
            filename: document.getFilePath()!,
        })).toString();
        preprocessor.transpiledDocument.setText(source);

        let diagnostics: Diagnostic[];
        try {
            delete config.preprocess;
            const res = svelte.compile(source, config);

            diagnostics = (((res.stats as any).warnings || res.warnings || []) as Warning[]).map(
                warning => {
                    const start = warning.start || { line: 1, column: 0 };
                    const end = warning.end || start;
                    return {
                        range: Range.create(start.line - 1, start.column, end.line - 1, end.column),
                        message: warning.message,
                        severity: DiagnosticSeverity.Warning,
                        source: 'svelte',
                        code: warning.code,
                    };
                },
            );
        } catch (err) {
            const start = err.start || { line: 1, column: 0 };
            const end = err.end || start;
            diagnostics = [
                {
                    range: Range.create(start.line - 1, start.column, end.line - 1, end.column),
                    message: err.message,
                    severity: DiagnosticSeverity.Error,
                    source: 'svelte',
                    code: err.code,
                },
            ];
        }

        await fixDiagnostics(document, preprocessor, diagnostics);
        return diagnostics;
    }

    private async loadConfig(path: string): Promise<SvelteConfig> {
        try {
            const { config } = await cosmic('svelte', {
                packageProp: false,
            }).load(path);
            return { ...DEFAULT_OPTIONS, ...config };
        } catch (err) {
            return { ...DEFAULT_OPTIONS, preprocess: {} };
        }
    }

    async formatDocument(document: Document): Promise<TextEdit[]> {
        if (!this.host.getConfig<boolean>('svelte.format.enable')) {
            return [];
        }

        const config = await prettier.resolveConfig(document.getFilePath()!);
        const sveltePkg = getSveltePackageInfo(document.getFilePath()!);
        const formattedCode = prettier.format(document.getText(), {
            ...config,
            plugins: [require.resolve('prettier-plugin-svelte')],
            parser: sveltePkg.version.major >= 3 ? ('svelte' as any) : 'html',
        });

        return [
            TextEdit.replace(
                Range.create(document.positionAt(0), document.positionAt(document.getTextLength())),
                formattedCode,
            ),
        ];
    }
}

interface Preprocessor extends PreprocessorGroup {
    fragments: {
        source: Fragment;
        transpiled: Fragment;
        code: string;
        map: RawSourceMap | RawIndexMap | string;
    }[];
    transpiledDocument: SvelteDocument;
}

function makePreprocessor(document: SvelteDocument, preprocessors: PreprocessorGroup = {}) {
    const preprocessor: Preprocessor = {
        fragments: [],
        transpiledDocument: new SvelteDocument(document.getURL(), document.getText()),
    };

    if (preprocessors.script) {
        preprocessor.script = (async (args: any) => {
            const res = await preprocessors.script!(args);
            if (res && res.map) {
                preprocessor.fragments.push({
                    source: document.script,
                    transpiled: preprocessor.transpiledDocument.script,
                    code: res.code,
                    map: res.map,
                });
            }
            return res;
        }) as any;
    }

    if (preprocessors.style) {
        preprocessor.style = (async (args: any) => {
            const res = await preprocessors.style!(args);
            if (res && res.map) {
                preprocessor.fragments.push({
                    source: document.style,
                    transpiled: preprocessor.transpiledDocument.style,
                    code: res.code,
                    map: res.map,
                });
            }
            return res;
        }) as any;
    }

    return preprocessor;
}

async function fixDiagnostics(
    document: Document,
    preprocessor: Preprocessor,
    diagnostics: Diagnostic[],
): Promise<void> {
    for (const fragment of preprocessor.fragments) {
        const newDiagnostics: Diagnostic[] = [];
        const fragmentDiagnostics: Diagnostic[] = [];
        for (let diag of diagnostics) {
            if (fragment.transpiled.isInFragment(diag.range.start)) {
                fragmentDiagnostics.push(diag);
            } else {
                newDiagnostics.push(diag);
            }
        }
        diagnostics = newDiagnostics;
        if (fragmentDiagnostics.length === 0) {
            continue;
        }

        await SourceMapConsumer.with(fragment.map, null, consumer => {
            for (const diag of fragmentDiagnostics) {
                diag.range = {
                    start: mapFragmentPositionBySourceMap(
                        fragment.source,
                        fragment.transpiled,
                        consumer,
                        diag.range.start,
                    ),
                    end: mapFragmentPositionBySourceMap(
                        fragment.source,
                        fragment.transpiled,
                        consumer,
                        diag.range.end,
                    ),
                };
            }
        });
    }

    const sortedFragments = preprocessor.fragments.sort(
        (a, b) => a.transpiled.offsetInParent(0) - b.transpiled.offsetInParent(0),
    );
    if (diagnostics.length > 0) {
        for (const diag of diagnostics) {
            for (const fragment of sortedFragments) {
                const start = preprocessor.transpiledDocument.offsetAt(diag.range.start);
                if (fragment.transpiled.details.container!.end > start) {
                    continue;
                }

                const sourceLength =
                    fragment.source.details.container!.end -
                    fragment.source.details.container!.start;
                const transpiledLength =
                    fragment.transpiled.details.container!.end -
                    fragment.transpiled.details.container!.start;
                const diff = sourceLength - transpiledLength;
                const end = preprocessor.transpiledDocument.offsetAt(diag.range.end);
                diag.range = {
                    start: document.positionAt(start + diff),
                    end: document.positionAt(end + diff),
                };
            }
        }
    }
}

function mapFragmentPositionBySourceMap(
    source: Fragment,
    transpiled: Fragment,
    consumer: SourceMapConsumer,
    pos: Position,
): Position {
    // Start with a position that exists in the transpiled fragment's parent

    // Map the position to be relative to the transpiled fragment only
    const transpiledPosition = transpiled.positionInFragment(pos);

    // Map the position, using the sourcemap, to a position in the source fragment
    const mappedPosition = consumer.originalPositionFor({
        line: transpiledPosition.line + 1,
        column: transpiledPosition.character,
    });
    const sourcePosition = {
        line: mappedPosition.line! - 1,
        character: mappedPosition.column!,
    };

    // Map the position to be relative to the source fragment's parent
    return source.positionInParent(sourcePosition);
}



/* TODO (just POC for now)
    - extract this somewhere as a class or add methods to "Document"...
    - consider refactoring to use an abstract syntax tree instead of regex
    - handle scenarios:
        - two imports with same name, different case: currently I assume they don't have a svelte component named "Something" and a js service "something", for instance
    - add tests to cover:
        console.log(getPotentialComponentName(`
            <Something />
            <script>
                import Something from "somestuff/something.svelte"
            </script>
            `, 57), 'should be', 'something') // clicked part of the path, not name (more complex example)
        console.log(getPotentialComponentName('import Something from "somestuff/something"', 9), 'should be', 'something') // clicked the var name
        console.log(getPotentialComponentName('import Something from "somestuff/something.svelte"', 27), 'should be', 'something') // clicked part of the path, not name
        console.log(getPotentialComponentName('import Something from "somestuff/something"', 35), 'should be', 'something') // clicked the file name
        console.log(getPotentialComponentName('import Something from "somestuff/something.svelte"', 43), 'should be', 'something') // clicked the extension, not name
        console.log(getPotentialComponentName('<Something />', 4), 'should be', 'Something')
        console.log(getPotentialComponentName('</Something>', 4), 'should be', 'Something')
        console.log(getPotentialComponentName('<Something>', 4), 'should be', 'Something')
*/
function getImportPathFromStart(docText:string, start:number) {
    const componentName = getPotentialComponentName(docText, start)
    const importPath = getImportPathFromName(docText, componentName)
    return importPath
    
    function getImportPathFromName(docText:string, name:string) : string | null {
        const match = new RegExp(`import ${name} from ['"]([^['"]+)['"]`, 'i').exec(docText)
        if (match == null) return null
        return match[1]
    }

    function getPotentialComponentName(docText:string, start:number) : string {
        const importedName = tryGetImportName(docText, start)
        if (importedName != null) return importedName
        const validNameChars = /[a-zA-Z0-9]/
        const name = getTextAround(docText, start, validNameChars)
        return name
    }
    
    function tryGetImportName(docText:string, start:number) : string | null {
        const line = getTextAround(docText, start, /[^$^\n\r]+/m)
        const match = /import ([a-zA-Z0-9]+) from/.exec(line)
        return match == null ? null : match[1]
    }
    
    function getTextAround(docText:string, start:number, regex:RegExp) : string {
        let text = ''
        let forward = start
        let backward = start
        let max = docText.length
        while (forward < max) {
        if (regex.test(docText[forward])) text += docText[forward]
        else break
        forward++
        }
        while (backward > 0) {
        backward--
        if (regex.test(docText[backward])) text = docText[backward] + text
        else break
        }
        return text
    }
}