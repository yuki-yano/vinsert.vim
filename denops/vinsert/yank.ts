import { type Denops, variable } from "./deps/denops.ts";
import { logInfo } from "./logger.ts";

export async function yankToRegister(
  denops: Denops,
  text: string,
  register: string,
): Promise<void> {
  await variable.register.set(denops, register, text);
  await logInfo(denops, "[vinsert] Saved text to the unnamed register.");
}
