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
    CompletionItem,
    FragmentPredicate,
    MarkupContent,
} from '../api';
import { SvelteDocument } from '../lib/documents/SvelteDocument';
import { RawSourceMap, RawIndexMap, SourceMapConsumer } from 'source-map';
import { CompileOptions, Warning } from 'svelte/types/compiler/interfaces';
import { importSvelte, getSveltePackageInfo } from './svelte/sveltePackage';
import { PreprocessorGroup } from 'svelte/types/compiler/preprocess';
import path, { resolve, dirname, basename } from 'path'
import fs from 'fs'
import { pathToUrl } from '../utils';
import ts, { PostfixUnaryExpression } from 'typescript';
import { TextDocument } from '../lib/documents/TextDocument';
import { convertRange, isSvelte } from './typescript/utils';
import { TypeScriptPlugin } from './TypeScriptPlugin';

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

        // TODO: not sure if need. try in non-svelte|html file...
        // const html = this.documents.get(document);
        // if (!html) {
        //     return null;
        // }

        this.hydrateSvelteFiles(document)

        // get auto-complete options for component name (and auto-import if needed)
        /*
            TODO: Tests
            - puts "<" if previous char is not "{" or "<"
            - does not add import if there is already an import
            - auto-imports when no <script> tag
            - auto-imports when <script> tag
            - auto-imports non-relative, falling back to relative
        */
        const docDir = dirname(document.getFilePath()!)
        const start = document.offsetAt(position)
        const docText = document.getText()
        const componentName = getPotentialComponentName(docText, start)
        const importedPath = getImportPathFromComponentName(docText, componentName)
        if (importedPath) return null // already imported. TODO: would be nice to go fetch any exported props for this component at this point instead
        const matches = this.tryResolveLoose(componentName, docDir)
        if (matches.length === 0) return null
        const scriptFragment = document.findFragment(TypeScriptPlugin.matchFragment)
        const noScriptFragment = scriptFragment == null || scriptFragment.details == null || scriptFragment.details.start == null
        const scriptLine = scriptFragment == null || scriptFragment.details == null || scriptFragment.details.start == null ? 
            document.lineCount - 1 : // if no script tag, we'll add one with the import at the bottom of the file
            document.positionAt(scriptFragment.details.start).line + 1 // insert after the opening script tag
        const startOfPosition = {
            line: position.line,
            character: position.character - componentName.length
        }
        const positionRange = {
            start: startOfPosition,
            end: startOfPosition
        }
        const prevCharIndex = start - componentName.length - 1
        const previousCharacter = prevCharIndex > -1 ? docText[prevCharIndex] : null
        const needsOpeningBracket = previousCharacter == null ? true : !/[<{]/.test(previousCharacter) // if there is a "{" or "<" directly before, don't insert a "<"
        const componentCompletions: CompletionItem[] = matches.map(m => {
            const fileName = removeSvelteOrHtmlExt(basename(m))
            const alreadyImported = getImportPathFromName(docText, fileName)
            let additionalTextEdits:TextEdit[]= []
            let markdown = fileName
            if (!alreadyImported) {
                const determinedModulePath = this.unResolve(docDir, m)
                const importText = `\timport ${fileName} from '${determinedModulePath}'\n`
                const additionalEdit = noScriptFragment ? `\n<script>\n${importText}\n</script>` : importText
                markdown = `##### Auto-import from '${determinedModulePath}'\n\`${additionalEdit}\``
                additionalTextEdits.push({
                    newText: additionalEdit,
                    range: {
                        start: { line: scriptLine, character: 0 },
                        end: { line: scriptLine, character: 0 }
                    }
                })
            }
            return {
                label: fileName,
                documentation: {
                    kind: 'markdown',
                    value: markdown
                },
                kind: CompletionItemKind.Text, // or Module, // or class?
                textEdit: {    
                    newText: `${needsOpeningBracket ? '<' : ''}${fileName}`,
                    range: positionRange
                },
                additionalTextEdits
            }
        })      
        const list = CompletionList.create(componentCompletions, true);
        return list
    }

    getDefinitions(document: Document, position: Position): DefinitionLink[] {
        if (!this.host.getConfig<boolean>('typescript.definitions.enable')) {
            return [];
        }
        this.hydrateSvelteFiles(document)
        const docDir = dirname(document.getFilePath()!)
        const start = document.offsetAt(position)
        const docText = document.getText()
        const componentName = getPotentialComponentName(docText, start)
        const modulePath = getImportPathFromComponentName(docText, componentName)
        if (modulePath === null) return []
        const matches = this.tryResolve(modulePath, docDir)
        if (matches.length === 0) return []
        const docs = new Map<string, Document>([[docDir, document]]);
        const range = {
            start: start - 2,
            length: 5 // TODO: highlight what they clicked (the found "componentName" pretty much, around "start")
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

    // given absolute path, return a 
    private unResolve(docDir:string, absoluteFile:string) {
        // determine which basepath works and use that as a start point
        if (this.basePaths == null) return fixSlashes(absoluteFile) // shouldn't happen, but better to give them something useful
        const absNoExtension = removeSvelteOrHtmlExt(absoluteFile)
        if (this.basePaths.length === 0) {
            const relative = relativeFromAbsolute(docDir, absoluteFile)
            return relative
        }
        for (let i = 0; i < this.basePaths.length; i++) {
            const base = this.basePaths[i];
            const works = absNoExtension.startsWith(base)
            if (works) {
                let result = absNoExtension.replace(base, '')
                result = result
                return fixSlashes(result)
            }
        }
        return fixSlashes(absoluteFile) // shouldn't happen, but better to give them something useful

        function fixSlashes(file:string):string {
            return forwardSlashes(removeStartSlash(file))
        }

        function removeStartSlash(file:string):string {
            return file.replace(/^[/\\]/, '') // remove beginning slash if any
        }

        function forwardSlashes(file:string):string {
            return file.replace(/\\/g, '/')
        }

        /*
        TODO: Tests:            
            console.log(relativeFromAbsolute('C:\\dev\\project\\components', 'c:/dev/project/components/sub/MyComponent.svelte'), 'should be', './sub/MyComponent.svelte') // also mix slashes and case
            console.log(relativeFromAbsolute('c:/dev/project/components/', 'c:/dev/project/components/sub/MyComponent.svelte'), 'should be', './sub/MyComponent.svelte') // down 1
            console.log(relativeFromAbsolute('c:/dev/project/components/', 'c:/dev/project/components/sub/sub2/MyComponent.svelte'), 'should be', './sub/sub2/MyComponent.svelte') // down 2
            console.log(relativeFromAbsolute('c:/dev/project/components/sub', 'c:/dev/project/components/MyComponent.svelte'), 'should be ', '../MyComponent.svelte') // up 1
            console.log(relativeFromAbsolute('c:/dev/project/components/sub/sub2', 'c:/dev/project/components/MyComponent.svelte'), 'should be ', '../../MyComponent.svelte') // up 2
        */
        function relativeFromAbsolute(currDir:string, absolutePath:string):string {
            // normalize slashes and casing
            absolutePath = path.resolve(path.dirname(absolutePath.toLowerCase()), path.basename(absolutePath)) // retain file capitalization
            currDir = path.resolve(currDir.toLowerCase())

            // go up or down as needed
            const goingDown = absolutePath.startsWith(currDir)
            if (goingDown) {
                const relative = './' + removeStartSlash(absolutePath.replace(currDir, ''))
                return forwardSlashes(relative)
            } else {
                let start = ''
                let max = 100
                let i = 0
                while (!absolutePath.startsWith(currDir)) {
                currDir = path.resolve(currDir, '../')
                start += '../'
                max++
                if (i > max) break; // could be in different drive
                }
                return forwardSlashes(start + removeStartSlash(absolutePath.replace(currDir, '')))
            }
        }
    }

    private tryResolveLoose(search: string, docDir: string) : string[] {
        if (this.svelteFiles === null) return []
        const matches = this.svelteFiles.filter(f => {
            const fileName = basename(f).toLowerCase()
            return fileName.indexOf(search.toLowerCase()) > -1
        })
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
function getImportPathFromComponentName(docText:string, componentName: string) {
    const importPath = getImportPathFromName(docText, componentName)
    return importPath
}

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

function removeSvelteOrHtmlExt(fileName) {
    return fileName.replace(/\.(?:svelte|html)$/, '')
}