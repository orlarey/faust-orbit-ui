export type FaustInputWidgetType = 'hslider' | 'vslider' | 'nentry' | 'button' | 'checkbox';
export type FaustPassiveWidgetType = 'hbargraph' | 'vbargraph';
export type FaustWidgetType = FaustInputWidgetType | FaustPassiveWidgetType;
export type FaustGroupType = 'vgroup' | 'hgroup' | 'tgroup';

// Normalized flat UI item used by concrete Faust UI renderers.
export type FaustUIItem = {
  path: string;
  type: FaustWidgetType;
  label: string;
  min: number;
  max: number;
  step: number;
};

// AST node for Faust UI language (group hierarchy + control leaves).
export type FaustUiAstGroupNode = {
  kind: 'group';
  type: FaustGroupType;
  label: string;
  children: FaustUiAstNode[];
};

// AST leaf node for Faust UI controls.
export type FaustUiAstControlNode = {
  kind: 'control';
  item: FaustUIItem;
};

export type FaustUiAstNode = FaustUiAstGroupNode | FaustUiAstControlNode;

// Backward-compatible alias for existing call sites.
export type FaustUiControlSpec = FaustUIItem;

type FaustUiRawNode = Record<string, unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object';
}

export function isFaustWidgetType(type: unknown): type is FaustWidgetType {
  return type === 'hslider'
    || type === 'vslider'
    || type === 'nentry'
    || type === 'button'
    || type === 'checkbox'
    || type === 'hbargraph'
    || type === 'vbargraph';
}

export function isFaustInputWidgetType(type: unknown): type is FaustInputWidgetType {
  return type === 'hslider' || type === 'vslider' || type === 'nentry' || type === 'button' || type === 'checkbox';
}

function isFaustGroupType(type: unknown): type is FaustGroupType {
  return type === 'vgroup' || type === 'hgroup' || type === 'tgroup';
}

function parseControlNode(node: FaustUiRawNode, type: FaustWidgetType): FaustUiAstControlNode | null {
  const rawPath =
    typeof node.address === 'string'
      ? node.address
      : typeof node.path === 'string'
        ? node.path
        : '';
  if (!rawPath) return null;

  let min = Number.isFinite(node.min) ? Number(node.min) : 0;
  let max = Number.isFinite(node.max) ? Number(node.max) : 1;
  let step = Number.isFinite(node.step) ? Number(node.step) : 0;

  if (type === 'button' || type === 'checkbox') {
    min = 0;
    max = 1;
    step = 1;
  }
  if (max <= min) {
    max = min + (type === 'button' || type === 'checkbox' ? 1 : 0.0001);
  }

  const label =
    typeof node.label === 'string' && node.label.trim()
      ? node.label
      : rawPath.split('/').filter(Boolean).pop() || rawPath;

  return {
    kind: 'control',
    item: {
      path: rawPath,
      type,
      label,
      min,
      max,
      step
    }
  };
}

function parseAstNode(node: unknown): FaustUiAstNode | null {
  if (!isRecord(node)) return null;
  const type = node.type;

  if (isFaustWidgetType(type)) {
    return parseControlNode(node, type);
  }

  if (isFaustGroupType(type)) {
    const label = typeof node.label === 'string' ? node.label : type;
    const rawItems = Array.isArray(node.items) ? node.items : [];
    const children = rawItems
      .map((entry) => parseAstNode(entry))
      .filter((entry): entry is FaustUiAstNode => !!entry);
    return {
      kind: 'group',
      type,
      label,
      children
    };
  }

  // Unknown node kinds are ignored.
  return null;
}

// Step 1: Parse unknown JSON into a typed Faust UI AST.
export function parseFaustUiAstFromUnknown(input: unknown): FaustUiAstNode[] {
  if (!Array.isArray(input)) {
    throw new Error('Faust UI must be an array');
  }
  return input
    .map((entry) => parseAstNode(entry))
    .filter((entry): entry is FaustUiAstNode => !!entry);
}

function flattenAstNode(node: FaustUiAstNode, out: FaustUIItem[]): void {
  if (node.kind === 'control') {
    out.push(node.item);
    return;
  }
  node.children.forEach((child) => flattenAstNode(child, out));
}

// Step 2: Convert typed AST to a normalized flat list of FaustUIItem.
export function flattenFaustUiAstToItems(ast: FaustUiAstNode[]): FaustUIItem[] {
  const out: FaustUIItem[] = [];
  ast.forEach((node) => flattenAstNode(node, out));
  return out;
}

// Convenience: parse unknown JSON directly into normalized items.
export function parseFaustUiItemsFromUnknown(input: unknown): FaustUIItem[] {
  return flattenFaustUiAstToItems(parseFaustUiAstFromUnknown(input));
}

// Backward-compatible function name.
export function parseFaustUiControlsFromUnknown(input: unknown): FaustUiControlSpec[] {
  return parseFaustUiItemsFromUnknown(input);
}
