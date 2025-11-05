import { type Denops, helper, variable } from "./deps/denops.ts";
import { is } from "./deps/unknownutil.ts";

const isError = is.InstanceOf(Error);

export async function isDebugEnabled(denops: Denops): Promise<boolean> {
  const flag = await variable.g.get(denops, "vinsert_debug");
  return flag === true || flag === 1 || flag === "true";
}

export async function logInfo(
  denops: Denops,
  message: string,
): Promise<void> {
  if (!(await isDebugEnabled(denops))) {
    return;
  }
  console.log(message);
  await helper.echo(denops, message).catch(() => {});
}

export async function logWarn(
  denops: Denops,
  message: string,
): Promise<void> {
  if (await isDebugEnabled(denops)) {
    console.warn(message);
  }
  await helper.echoerr(denops, message).catch(() => {});
}

export async function logError(
  denops: Denops,
  message: string,
  error?: unknown,
): Promise<void> {
  if (await isDebugEnabled(denops)) {
    console.error(message, error);
    const detail = isError(error) ? error.message : String(error ?? "");
    await helper.echoerr(denops, `${message}: ${detail}`).catch(() => {});
  } else {
    await helper.echoerr(denops, message).catch(() => {});
  }
}
