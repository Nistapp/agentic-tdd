import { parse, Lang, SgRoot, SgNode } from '@ast-grep/napi';

import type { ISymbolResolver } from '../core/interfaces.js';
import type { Range } from '../core/types.js';

const EXTENSION_LANG: Record<string, Lang> = {
  '.ts': Lang.TypeScript,
  '.tsx': Lang.Tsx,
  '.js': Lang.JavaScript,
  '.jsx': Lang.Tsx,
  '.css': Lang.Css,
  '.html': Lang.Html,
};

const ENCLOSING_KINDS = new Set([
  'function_declaration',
  'method_definition',
  'arrow_function',
  'class_declaration',
  'generator_function_declaration',
  'function_expression',
]);

function detectLang(filePath: string): Lang | null {
  for (const [ext, lang] of Object.entries(EXTENSION_LANG)) {
    if (filePath.endsWith(ext)) return lang;
  }
  return null;
}

/**
 * Build a qualified name for a function/method/class node.
 *
 * For arrow_function nodes the name is resolved from the parent
 * (variable_declarator or public_field_definition).  For function_declaration
 * and method_definition the name comes from the node's own identifier.
 * Class ancestors are prepended to produce e.g. `ClassName.methodName`.
 */
function buildQualifiedName(node: SgNode): string {
  const kind = String(node.kind());

  // Resolve the symbol's own name (may involve the parent for arrows)
  const ownName = resolveOwnName(node);

  // Start walking from the parent so we don't double-count the node
  // itself when it is a class_declaration.
  let current: SgNode | null;
  if (kind === 'class_declaration' || kind === 'arrow_function') {
    current = node.parent();
  } else {
    current = node.parent();
  }

  // Walk up through class ancestors
  const ancestors: string[] = [];
  while (current) {
    const k = String(current.kind());
    if (k === 'class_declaration') {
      const cn = resolveClassName(current);
      ancestors.unshift(cn);
    }
    current = current.parent();
  }

  return [...ancestors, ownName].join('.');
}

/**
 * Extract the class name from a class_declaration node.
 * In TypeScript the class name is a `type_identifier`; in JavaScript
 * it is a plain `identifier`.  Falls back gracefully for languages
 * where `type_identifier` is not a valid kind.
 */
function resolveClassName(classNode: SgNode): string {
  try {
    const n = classNode.find({ rule: { kind: 'type_identifier' } } as never);
    if (n) return n.text();
  } catch {
    // `type_identifier` is not a valid kind in this language
  }
  try {
    const n = classNode.find({ rule: { kind: 'identifier' } } as never);
    if (n) return n.text();
  } catch {
    // `identifier` not valid either — should not happen
  }
  return 'anonymous';
}

/**
 * Extract the owner name of a function/method/arrow node.
 */
function resolveOwnName(node: SgNode): string {
  const kind = String(node.kind());

  if (kind === 'method_definition') {
    const n = node.find({ rule: { kind: 'property_identifier' } } as never);
    return n ? n.text() : 'anonymous';
  }

  if (kind === 'function_declaration' || kind === 'generator_function_declaration') {
    const n = node.find({ rule: { kind: 'identifier' } } as never);
    return n ? n.text() : 'anonymous';
  }

  if (kind === 'arrow_function' || kind === 'function_expression') {
    const parent = node.parent();
    if (!parent) return 'anonymous';
    const parentKind = String(parent.kind());

    if (parentKind === 'variable_declarator') {
      const n = parent.find({ rule: { kind: 'identifier' } } as never);
      return n ? n.text() : 'anonymous';
    }
    if (parentKind === 'public_field_definition') {
      const n = parent.find({ rule: { kind: 'property_identifier' } } as never);
      return n ? n.text() : 'anonymous';
    }
    return 'anonymous';
  }

  if (kind === 'class_declaration') {
    return resolveClassName(node);
  }

  return 'anonymous';
}

/**
 * Walk the AST depth-first and find the deepest enclosing symbol (function,
 * method, or class) that contains the given 1-based line number.
 */
function findEnclosingSymbol(root: SgNode, line0: number): SgNode | null {
  let deepest: SgNode | null = null;

  function walk(node: SgNode): void {
    const r = node.range();
    if (r.start.line <= line0 && r.end.line >= line0) {
      if (ENCLOSING_KINDS.has(String(node.kind()))) {
        deepest = node;
      }
      for (const child of node.children()) {
        walk(child);
      }
    }
  }

  walk(root);
  return deepest;
}

// ---------------------------------------------------------------------------
// AstGrepSymbolResolver
// ---------------------------------------------------------------------------

export class AstGrepSymbolResolver implements ISymbolResolver {
  mapRangesToSymbols(filePath: string, source: string, ranges: Range[]): string[] {
    const lang = detectLang(filePath);
    if (!lang) return [];

    let sgRoot: SgRoot;
    try {
      sgRoot = parse(lang, source);
    } catch {
      return [];
    }

    const symbols = new Set<string>();

    for (const range of ranges) {
      // Convert 1-based (git diff) to 0-based (ast-grep)
      const sym = findEnclosingSymbol(sgRoot.root(), range.start - 1);
      if (sym) {
        symbols.add(buildQualifiedName(sym));
      }
    }

    return [...symbols].sort();
  }
}
