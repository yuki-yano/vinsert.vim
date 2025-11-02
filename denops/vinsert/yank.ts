import { helper, variable, type Denops } from "./deps/denops.ts";

export async function yankToRegister(
  denops: Denops,
  text: string,
  register: string,
): Promise<void> {
  await variable.register.set(denops, register, text);
  await helper.echo(denops, `[vinsert] 無名レジスタにテキストを保存しました。`);
}
