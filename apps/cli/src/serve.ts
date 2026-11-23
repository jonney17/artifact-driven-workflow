import type { SdlcContext } from '@sdlc/app';

/** Placeholder until the API server (apps/server) lands; replaced in the next commit. */
export async function startServer(_ctx: SdlcContext, port: number, out: (l: string) => void): Promise<void> {
  out(`server not built yet (port ${port})`);
}
