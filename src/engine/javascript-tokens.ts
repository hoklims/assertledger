import { createScanner, SyntaxKind } from "typescript/unstable/ast";

export interface JavaScriptToken {
  readonly kind: SyntaxKind;
  readonly text: string;
  readonly value: string;
  readonly start: number;
  readonly end: number;
}

/**
 * Error-tolerant lexical scanning, shared by repository analysis and module discovery.
 * Template text stays literal; expressions retain their tokens, including nested templates.
 * This is not a parser: slash/regex disambiguation still needs grammar context.
 */
export function* scanJavaScriptTokens(
  source: string,
  file = "<source>",
): Generator<JavaScriptToken, void> {
  let position = 0;
  try {
    const scanner = createScanner(true, undefined, source);
    const templateExpressionBraceDepths: number[] = [];
    for (;;) {
      let kind = scanner.scan();
      if (kind === SyntaxKind.EndOfFile) {
        if (scanner.getTokenEnd() !== source.length) throw new Error("premature scanner EOF");
        return;
      }
      const templateDepthIndex = templateExpressionBraceDepths.length - 1;
      if (
        kind === SyntaxKind.CloseBraceToken &&
        templateDepthIndex >= 0 &&
        templateExpressionBraceDepths[templateDepthIndex] === 0
      ) {
        kind = scanner.reScanTemplateToken(false);
        if (kind === SyntaxKind.TemplateTail) templateExpressionBraceDepths.pop();
      } else if (kind === SyntaxKind.TemplateHead) {
        templateExpressionBraceDepths.push(0);
      } else if (templateDepthIndex >= 0 && kind === SyntaxKind.OpenBraceToken) {
        templateExpressionBraceDepths[templateDepthIndex] =
          (templateExpressionBraceDepths[templateDepthIndex] ?? 0) + 1;
      } else if (templateDepthIndex >= 0 && kind === SyntaxKind.CloseBraceToken) {
        templateExpressionBraceDepths[templateDepthIndex] =
          (templateExpressionBraceDepths[templateDepthIndex] ?? 0) - 1;
      }
      const start = scanner.getTokenStart();
      const end = scanner.getTokenEnd();
      if (start < position || start >= source.length || end > source.length) {
        throw new Error("invalid scanner position");
      }
      if (end <= start) {
        // The context-free scanner can return an empty private identifier, e.g. '#' in /#/.
        // Retain init/closure recovery: consume that character, never collect an empty token.
        position = start + 1;
        scanner.resetTokenState(position);
        continue;
      }
      position = end;
      yield {
        kind,
        text: scanner.getTokenText(),
        value: scanner.getTokenValue(),
        start,
        end,
      };
    }
  } catch (cause) {
    throw new TypeError(`JAVASCRIPT_TOKENIZATION_FAILED: ${JSON.stringify(file)} at ${position}`, {
      cause,
    });
  }
}
