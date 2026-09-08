import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import ts from 'typescript';

const root = path.resolve(import.meta.dirname, '..');
const config = ts.readConfigFile(path.join(root, 'tsconfig.json'), ts.sys.readFile);
const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
const program = ts.createProgram(parsed.fileNames, parsed.options);
const checker = program.getTypeChecker();
const routeMethods = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'all']);

/** Includes async factory implementations whose public RequestHandler annotation erases Promise types. */
const isAsynchronousHandler = (node: ts.Node, seen = new Set<ts.Node>()): boolean => {
    if (seen.has(node)) return false;
    seen.add(node);
    if (ts.canHaveModifiers(node)
        && ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword)) return true;
    const type = checker.getTypeAtLocation(node);
    if (type.getCallSignatures().some((signature) => {
        const result = signature.getReturnType();
        return (result.isUnion() ? result.types : [result]).some((part) => part.getProperty('then'));
    })) return true;

    if (ts.isVariableDeclaration(node) || ts.isPropertyAssignment(node)) {
        return Boolean(node.initializer && isAsynchronousHandler(node.initializer, seen));
    }
    if (ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isFunctionDeclaration(node)) {
        if (!node.body) return false;
        if (!ts.isBlock(node.body)) return isAsynchronousHandler(node.body, seen);
        let asyncReturn = false;
        const inspectReturns = (child: ts.Node) => {
            if (ts.isReturnStatement(child) && child.expression) {
                asyncReturn ||= isAsynchronousHandler(child.expression, seen);
            } else if (!ts.isFunctionLike(child)) {
                ts.forEachChild(child, inspectReturns);
            }
        };
        ts.forEachChild(node.body, inspectReturns);
        return asyncReturn;
    }
    if (ts.isCallExpression(node)) return isAsynchronousHandler(node.expression, seen);
    let symbol = checker.getSymbolAtLocation(ts.isPropertyAccessExpression(node) ? node.name : node);
    if (symbol && (symbol.flags & ts.SymbolFlags.Alias)) symbol = checker.getAliasedSymbol(symbol);
    return symbol?.declarations?.some((declaration) => isAsynchronousHandler(declaration, seen)) ?? false;
};

/** Enumerates actual Router method calls, leaving unrelated calls and router.use middleware intact. */
const routesIn = (source: ts.SourceFile) => {
    const calls: ts.CallExpression[] = [];
    const visit = (node: ts.Node) => {
        if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
            && node.expression.expression.getText(source) === 'router'
            && routeMethods.has(node.expression.name.text)) calls.push(node);
        ts.forEachChild(node, visit);
    };
    visit(source);
    return calls;
};

const wrapper = (node: ts.Node): node is ts.CallExpression => ts.isCallExpression(node)
    && ts.isIdentifier(node.expression) && node.expression.text === 'asyncHandler';

test('every asynchronous Controller registered in a Router is tracked by one asyncHandler', () => {
    let asynchronousRoutes = 0;
    for (const source of program.getSourceFiles().filter((file) => file.fileName.replaceAll('\\', '/').includes('/src/routes/'))) {
        for (const call of routesIn(source)) {
            const handler = call.arguments[call.arguments.length - 1];
            const location = `${path.relative(root, source.fileName)} ${call.arguments[0].getText(source)}`;
            if (wrapper(handler)) {
                assert.equal(handler.arguments.length, 1, location);
                assert.equal(wrapper(handler.arguments[0]), false, `Nested asyncHandler at ${location}`);
                if (isAsynchronousHandler(handler.arguments[0])) asynchronousRoutes += 1;
            } else {
                assert.equal(isAsynchronousHandler(handler), false, `Untracked asynchronous Controller at ${location}`);
            }
        }
    }
    assert.ok(asynchronousRoutes > 100, 'The guard must inspect the complete application route graph.');
});

test('Playlist factory handlers are covered even though RequestHandler hides their Promise result', () => {
    const source = program.getSourceFile(path.join(root, 'src/routes/content/playlistRoutes.ts'))!;
    const routes = routesIn(source);
    assert.equal(routes.length, 9);
    for (const route of routes) {
        const handler = route.arguments[route.arguments.length - 1];
        assert.ok(wrapper(handler));
        assert.equal(isAsynchronousHandler(handler.arguments[0]), true);
    }
});

test('administrator upload and composition middleware keep their existing execution order', () => {
    const manager = program.getSourceFile(path.join(root, 'src/routes/content/contentManagerRoutes.ts'))!;
    const upload = routesIn(manager).find((route) => route.arguments[0].getText(manager) === "'/audioTrack/create'")!;
    assert.deepEqual(upload.arguments.slice(1).map((argument) => argument.getText(manager)), [
        'uploadConcurrencyLimit',
        'attachRequestAbortSignal',
        'cleanupTemporaryUploads',
        'requireUploadSize(maximumMediaUploadMb + maxImageUploadMb + 2)',
        'createMediaTrackUpload',
        'asyncHandler(contentController.createAudioTrackWeb)'
    ]);
    const composition = program.getSourceFile(path.join(root, 'src/routes/content/compositionRoutes.ts'))!;
    const create = routesIn(composition).find((route) => route.arguments[0].getText(composition) === "'/content-collections'"
        && (route.expression as ts.PropertyAccessExpression).name.text === 'post')!;
    assert.deepEqual(create.arguments.slice(1).map((argument) => argument.getText(composition)), [
        'requireAuth', 'requireAdmin', 'asyncHandler(contentCollectionController.createContentCollection)'
    ]);
});
