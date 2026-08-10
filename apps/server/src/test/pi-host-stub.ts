export class Text {
  constructor(private readonly text: string = '') {}

  render(_width: number): string[] {
    return this.text.split('\n');
  }

  invalidate(): void {}
}

export function keyHint(keybinding: string, description: string): string {
  return `<${keybinding}:${description}>`;
}
