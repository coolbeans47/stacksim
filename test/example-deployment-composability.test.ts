import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import ts from "typescript";

const classicRestApiConstructs = new Set(["RestApi", "LambdaRestApi", "SpecRestApi"]);

function constructName(expression: ts.LeftHandSideExpression): string | undefined {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  return undefined;
}

function propertyName(property: ts.ObjectLiteralElementLike): string | undefined {
  if (!ts.isPropertyAssignment(property)) return undefined;
  if (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) return property.name.text;
  return undefined;
}

test("installable examples do not claim the regional API Gateway account singleton", async () => {
  const examplesRoot = join(process.cwd(), "examples");
  const directories = (await readdir(examplesRoot, { withFileTypes: true }))
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name);
  let restApiCount = 0;

  for (const directory of directories) {
    const appPath = join(examplesRoot, directory, "app.ts");
    let sourceText: string;
    try {
      sourceText = await readFile(appPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }

    const sourceFile = ts.createSourceFile(appPath, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const visit = (node: ts.Node): void => {
      if (ts.isNewExpression(node) && classicRestApiConstructs.has(constructName(node.expression) ?? "")) {
        restApiCount += 1;
        const options = node.arguments?.[2];
        const cloudWatchRole = options && ts.isObjectLiteralExpression(options)
          ? options.properties.find(property => propertyName(property) === "cloudWatchRole")
          : undefined;
        const disabled = cloudWatchRole
          && ts.isPropertyAssignment(cloudWatchRole)
          && cloudWatchRole.initializer.kind === ts.SyntaxKind.FalseKeyword;
        const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
        assert.ok(disabled, `${appPath}:${line + 1} must set cloudWatchRole: false so examples remain deployable in any order`);
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }

  assert.ok(restApiCount > 0, "Expected at least one classic API Gateway REST API example");
});
