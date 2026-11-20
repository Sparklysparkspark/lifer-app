// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import type { ReactNode } from "react";
import { useCollectionUrlState } from "./useCollectionUrlState";

function renderAt(url: string) {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <MemoryRouter initialEntries={[url]}>{children}</MemoryRouter>
  );
  return renderHook(() => useCollectionUrlState(), { wrapper });
}

describe("photos taken URL state", () => {
  it("reads the param, falling back to anywhere", () => {
    expect(renderAt("/collection?photosTaken=here").result.current.itemFilters.photosTaken).toBe("here");
    expect(renderAt("/collection?photosTaken=elsewhere").result.current.photosTakenFilter).toBe("elsewhere");
    expect(renderAt("/collection?photosTaken=bogus").result.current.photosTakenFilter).toBe("anywhere");
    expect(renderAt("/collection").result.current.photosTakenFilter).toBe("anywhere");
  });

  it("is cleared with the other filters, keeping the region", () => {
    const { result } = renderAt("/collection?region=r1&photosTaken=elsewhere&show=collected");
    act(() => result.current.clearFilters());
    expect(result.current.photosTakenFilter).toBe("anywhere");
    expect(result.current.stateFilter).toBe("all");
    expect(result.current.regionId).toBe("r1");
  });
});
