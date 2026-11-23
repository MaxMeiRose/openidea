import { IpcError, type References } from "@/platform/ipc";
import { tx } from "@/platform/i18n";

export const MAX_REFERENCE_REFRESHES = 8;

/** Counts and refactorings must finish a changed model's search before using its answer. */
export async function currentReferences(
  query: () => Promise<References>,
  wanted: () => boolean = () => true,
): Promise<References> {
  for (let i = 0; i < MAX_REFERENCE_REFRESHES; i++) {
    if (!wanted()) throw new IpcError({ kind: "cancelled", message: "cancelled" });
    const refs = await query();
    if (!wanted()) throw new IpcError({ kind: "cancelled", message: "cancelled" });
    if (!refs.stale) return refs;
  }
  throw new Error(tx("Usages are still updating; try again shortly"));
}
