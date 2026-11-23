import { describe, expect, it, vi } from "vitest";
import { currentReferences } from "./currentReferences";

describe("current references", () => {
  it("uses the new answer after multiple model changes", async () => {
    const fresh = { locations: [], incomplete: null };
    const query = vi
      .fn()
      .mockResolvedValueOnce({ ...fresh, stale: true })
      .mockResolvedValueOnce({ ...fresh, stale: true })
      .mockResolvedValueOnce(fresh);
    expect(await currentReferences(query)).toBe(fresh);
    expect(query).toHaveBeenCalledTimes(3);
  });

  it("stops after cancellation instead of reasking for an obsolete target", async () => {
    let wanted = true;
    const query = vi.fn(async () => {
      wanted = false;
      return { locations: [], incomplete: null, stale: true };
    });
    await expect(currentReferences(query, () => wanted)).rejects.toMatchObject({ kind: "cancelled" });
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("does not turn a model that keeps changing into a fresh empty result", async () => {
    const query = vi.fn(async () => ({ locations: [], incomplete: null, stale: true }));
    await expect(currentReferences(query)).rejects.toThrow("Usages are still updating");
    expect(query.mock.calls.length).toBeLessThan(10);
  });
});
