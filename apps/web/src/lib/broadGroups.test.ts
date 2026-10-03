import { describe, expect, it } from "vitest";
import { broadGroups, primaryBroadGroup } from "./broadGroups";

describe("broad groups", () => {
  it("puts owls under Owls first and Raptors too", () => {
    expect(broadGroups({ taxonClass: "aves", family: "Strigidae" })).toEqual(["Owls", "Raptors"]);
    expect(primaryBroadGroup({ taxonClass: "aves", family: "Tytonidae" })).toBe("Owls");
  });

  it("uses the order when the family isn't listed", () => {
    expect(primaryBroadGroup({ taxonClass: "aves", family: "Turdidae", taxonOrder: "Passeriformes" })).toBe("Songbirds");
    expect(primaryBroadGroup({ taxonClass: "mammalia", family: "Vespertilionidae", taxonOrder: "Chiroptera" })).toBe("Bats");
  });

  it("files whales by family, though most sit under Artiodactyla", () => {
    expect(primaryBroadGroup({ taxonClass: "mammalia", family: "Balaenopteridae", taxonOrder: "Artiodactyla" })).toBe("Whales & Dolphins");
    expect(primaryBroadGroup({ taxonClass: "mammalia", family: "Cervidae", taxonOrder: "Artiodactyla" })).toBe("Hoofed Mammals");
  });

  it("splits reptiles into snakes, crocodilians and lizards", () => {
    expect(primaryBroadGroup({ taxonClass: "squamata", family: "Viperidae" })).toBe("Snakes");
    expect(primaryBroadGroup({ taxonClass: "squamata", family: "Alligatoridae" })).toBe("Crocodilians");
    expect(primaryBroadGroup({ taxonClass: "squamata", family: "Iguanidae" })).toBe("Lizards");
    expect(primaryBroadGroup({ taxonClass: "testudines", family: "Emydidae" })).toBe("Turtles");
  });

  it("falls back to Other Birds, or the class's own name", () => {
    expect(primaryBroadGroup({ taxonClass: "aves", family: "Otididae", taxonOrder: "Otidiformes" })).toBe("Other Birds");
    expect(primaryBroadGroup({ taxonClass: "actinopterygii", family: "Salmonidae" })).toBe("Fish");
    expect(broadGroups({ taxonClass: "actinopterygii", family: "Salmonidae" })).toEqual([]);
  });
});
