import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';
import { runInNewContext } from 'node:vm';
import * as ts from 'typescript';
import {
  generateAllPermissions,
  DEFAULT_ROLES,
  DEFAULT_PERMISSION_MATRIX,
} from '../prisma/seeds/shared/permissions.seed';

function files(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = join(directory, entry.name);
    return entry.isDirectory()
      ? files(file)
      : /\.tsx?$/.test(file) && !file.endsWith('.spec.ts')
        ? [file]
        : [];
  });
}

// These two modules contain only pure catalog/routing code; no application or
// credential-bearing modules are loaded while auditing their exports.
function pureExports(file: string): Record<string, unknown> {
  const module = { exports: {} };
  const compiled = ts.transpileModule(readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 },
  });
  runInNewContext(compiled.outputText, { module, exports: module.exports }, { timeout: 1000 });
  return module.exports;
}

export function auditPermissionContracts(
  backendRoot = resolve(__dirname, '..'),
  webRoot = resolve(backendRoot, '../BelivrHQ-Web'),
) {
  const catalog = generateAllPermissions();
  const names = new Set(catalog.map((p) => p.name));
  const issues: string[] = [];
  let backendReferences = 0;
  let frontendReferences = 0;
  if (names.size !== catalog.length) issues.push('Backend catalog has duplicate permission names');
  for (const role of DEFAULT_ROLES) {
    const grants = role.name === 'super_admin' ? [...names] : DEFAULT_PERMISSION_MATRIX[role.name];
    if (!grants) issues.push(`Missing role template: ${role.name}`);
    for (const grant of grants ?? [])
      if (!names.has(grant)) issues.push(`Unknown template grant: ${role.name} → ${grant}`);
  }
  const check = (code: string, file: string, frontend: boolean) => {
    if (frontend) frontendReferences++;
    else backendReferences++;
    if (!names.has(code))
      issues.push(
        `${frontend ? relative(webRoot, file) : relative(backendRoot, file)}: unknown permission ${code}`,
      );
  };
  for (const file of files(join(backendRoot, 'src'))) {
    const source = ts.createSourceFile(
      file,
      readFileSync(file, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
    );
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node) && node.expression.getText(source) === 'RequirePermissions')
        for (const argument of node.arguments)
          if (ts.isStringLiteral(argument)) check(argument.text, file, false);
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  const webAvailable = existsSync(join(webRoot, 'src/lib/menu-catalog.ts'));
  if (webAvailable) {
    const exported = pureExports(join(webRoot, 'src/lib/menu-catalog.ts'));
    const valid = exported.isValidPermission as (name: string) => boolean;
    for (const name of names) if (!valid(name)) issues.push(`Frontend catalog missing: ${name}`);
    const candidates = new Set<string>((exported.EXTRA_PERMISSIONS as string[] | undefined) ?? []);
    for (const resource of exported.COARSE_RESOURCES as string[])
      for (const action of ['view', 'create', 'read', 'update', 'delete'])
        candidates.add(`${resource}:${action}`);
    for (const [resource, surfaces] of Object.entries(
      exported.SURFACE_RESOURCES as Record<string, string[]>,
    )) {
      for (const action of ['view', 'create', 'read', 'update', 'delete'])
        candidates.add(`${resource}:${action}`);
      for (const surface of surfaces)
        for (const action of ['create', 'read', 'update', 'delete'])
          candidates.add(`${resource}:${surface}:${action}`);
    }
    for (const name of candidates)
      if (valid(name) && !names.has(name))
        issues.push(`Frontend accepts an unseeded code: ${name}`);
    for (const file of files(join(webRoot, 'src'))) {
      const source = ts.createSourceFile(
        file,
        readFileSync(file, 'utf8'),
        ts.ScriptTarget.Latest,
        true,
      );
      const visit = (node: ts.Node) => {
        if (ts.isCallExpression(node)) {
          const called = node.expression.getText(source);
          if (
            called === 'can' &&
            node.arguments.length === 2 &&
            node.arguments.every(ts.isStringLiteral)
          )
            check(
              `${(node.arguments[0] as ts.StringLiteral).text}:${(node.arguments[1] as ts.StringLiteral).text}`,
              file,
              true,
            );
          if (called === 'canAny')
            for (const argument of node.arguments)
              if (ts.isStringLiteral(argument)) check(argument.text, file, true);
        }
        if (
          ts.isPropertyAssignment(node) &&
          node.name.getText(source) === 'permission' &&
          ts.isStringLiteral(node.initializer)
        )
          check(node.initializer.text, file, true);
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
  }
  return {
    roles: DEFAULT_ROLES.length,
    permissions: names.size,
    backendReferences,
    frontendReferences,
    webAvailable,
    issues,
  };
}

if (require.main === module) {
  const result = auditPermissionContracts();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.issues.length) process.exitCode = 1;
}
