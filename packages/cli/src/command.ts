/** Every dx subcommand has this shape. To add a tool: write a file in commands/ and list it in index.ts. */
export interface Command {
  name: string;
  aliases?: string[];
  summary: string;
  usage: string;
  run(args: string[]): Promise<number | void>;
}
