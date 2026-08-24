import type IntlMessageFormat from 'intl-messageformat';

import {
  installBundleMessageValidator,
  type LocalizationBundle
} from './contract';

type FormatterConstructor = typeof IntlMessageFormat;
type VariableType = 'date' | 'number' | 'string' | 'time' | undefined;
interface MessageAstNode {
  type: number;
  value?: string;
  options?: Record<string, { value: readonly MessageAstNode[] }>;
  children?: readonly MessageAstNode[];
}

const explicitVariableType = (nodeType: number): VariableType => {
  if (nodeType === 2 || nodeType === 6) return 'number';
  if (nodeType === 3) return 'date';
  if (nodeType === 4) return 'time';
  if (nodeType === 5) return 'string';
  return undefined;
};

/** Parses one ICU message into its named-variable and explicit formatter contract. */
const variableContract = (
  Formatter: FormatterConstructor,
  message: string,
  locale: string
) => {
  const variables = new Map<string, VariableType>();
  const visit = (nodes: readonly MessageAstNode[]) => {
    for (const node of nodes) {
      if (node.type === 8) throw new Error('Localization messages must be plain text.');
      if (node.type >= 1 && node.type <= 6 && node.value) {
        const nextType = explicitVariableType(node.type);
        const currentType = variables.get(node.value);
        if (currentType && nextType && currentType !== nextType) {
          throw new Error('A localization variable uses incompatible formatter types.');
        }
        variables.set(node.value, nextType ?? currentType);
      }
      for (const option of Object.values(node.options ?? {})) visit(option.value);
      if (node.children) visit(node.children);
    }
  };
  const formatter = new Formatter(message, locale);
  visit(formatter.getAst() as readonly MessageAstNode[]);
  return variables;
};

const validateMessages = (
  Formatter: FormatterConstructor,
  bundle: LocalizationBundle,
  fallback: LocalizationBundle
) => {
  for (const [key, fallbackMessage] of Object.entries(fallback.messages)) {
    const expected = variableContract(Formatter, fallbackMessage, fallback.locale);
    const received = variableContract(Formatter, bundle.messages[key], bundle.locale);
    const expectedNames = [...expected.keys()].sort();
    const receivedNames = [...received.keys()].sort();
    if (expectedNames.length !== receivedNames.length
      || expectedNames.some((name, index) => name !== receivedNames[index])) {
      throw new Error('A localization message does not match its named-variable contract.');
    }
    for (const name of expectedNames) {
      const expectedType = expected.get(name);
      const receivedType = received.get(name);
      if (expectedType && receivedType && expectedType !== receivedType) {
        throw new Error('A localization message does not match its variable-type contract.');
      }
    }
  }
};

/** Activates bounded ICU parsing for every downloaded or cached localization bundle. */
export const installBundleValidation = (Formatter: FormatterConstructor) => {
  installBundleMessageValidator((bundle, fallback) => {
    validateMessages(Formatter, bundle, fallback);
  });
};
