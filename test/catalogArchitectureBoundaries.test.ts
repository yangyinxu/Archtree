import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import ts from 'typescript';

const root = path.resolve(import.meta.dirname, '..');

/** Returns implementation source paths without scanning dependencies or generated output. */
const sourceFiles = (directory: string): string[] => readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => entry.isDirectory()
        ? sourceFiles(path.join(directory, entry.name))
        : entry.name.endsWith('.ts') ? [path.join(directory, entry.name)] : []);

/** Reads declared module dependencies so formatting and comments cannot bypass the boundary check. */
const importsFor = (filename: string) => {
    const source = ts.createSourceFile(filename, readFileSync(filename, 'utf8'), ts.ScriptTarget.Latest, true);
    return source.statements.filter(ts.isImportDeclaration).map((declaration) => ({
        target: (declaration.moduleSpecifier as ts.StringLiteral).text,
        typeOnly: declaration.importClause?.isTypeOnly === true
            || (declaration.importClause?.namedBindings
                && ts.isNamedImports(declaration.importClause.namedBindings)
                && declaration.importClause.namedBindings.elements.every((element) => element.isTypeOnly))
    }));
};

test('application, persistence, and lifecycle services do not depend on HTTP Controllers', () => {
    for (const directory of ['src/application', 'src/repositories', 'src/services']) {
        for (const filename of sourceFiles(path.join(root, directory))) {
            for (const dependency of importsFor(filename)) {
                assert.doesNotMatch(dependency.target, /(?:^|\/)controllers(?:\/|$)/, filename);
            }
        }
    }
});

test('Content Manager rendering has no runtime dependency on HTTP, database, or storage modules', () => {
    const filename = path.join(root, 'src/views/contentManager/managePageView.ts');
    for (const dependency of importsFor(filename).filter((entry) => !entry.typeOnly)) {
        assert.doesNotMatch(
            dependency.target,
            /(?:^|\/)(?:controllers|middleware|infrastructure|repositories|services|models)(?:\/|$)/,
            `Rendering must receive data instead of importing ${dependency.target}`
        );
    }
});

test('Content Manager base CSS and visual overrides retain their original cascade order', () => {
    const source = readFileSync(path.join(root, 'src/views/contentManager/managePageView.ts'), 'utf8');
    const cssNames = [...source.matchAll(/href="\/assets\/([^"\s]+\.css)"/g)].map((match) => match[1]);
    assert.deepEqual(cssNames, ['archtree.css', 'content-manager-base.css', 'content-manager.css']);
    for (const filename of cssNames) {
        assert.ok(readFileSync(path.join(root, 'src/public', filename), 'utf8').trim());
    }
});
