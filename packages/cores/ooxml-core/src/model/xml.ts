export interface XmlNode {
  readonly local: string;
  readonly uri: string;
  attr(name: string, uri?: string): string | undefined;
  /**
   * @returns the namespace `prefix` is bound to at this element, or undefined
   *   when it is not declared. Answers only while the visitor's `onOpen`
   *   runs; later the bindings in scope have moved on.
   */
  namespaceOf(prefix: string): string | undefined;
}

export interface XmlVisitor {
  readonly onOpen?: (node: XmlNode) => void;
  readonly onClose?: (local: string, uri: string) => void;
  readonly onText?: (text: string) => void;
}
