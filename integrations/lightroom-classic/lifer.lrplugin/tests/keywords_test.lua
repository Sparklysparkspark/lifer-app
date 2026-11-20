-- Run with: lua tests/keywords_test.lua (from lifer.lrplugin). Plain asserts, no framework.
package.path = "./?.lua;" .. package.path
local Json = require("Json")
local Keywords = require("Keywords")

local function eq(a, b, label)
  assert(a == b, (label or "") .. ": expected " .. tostring(b) .. ", got " .. tostring(a))
end

-- JSON
local doc = Json.decode('{"items":[{"scientificName":"Ardea herodias","bestRating":4,"isTarget":false,"x":null}],"nextCursor":null}')
eq(doc.items[1].scientificName, "Ardea herodias", "decode string")
eq(doc.items[1].bestRating, 4, "decode number")
eq(doc.items[1].isTarget, false, "decode false")
eq(doc.nextCursor, nil, "decode null")
eq(Json.decode('"\\u00e9\\n"'), "\195\169\n", "escapes")
local bad, why = Json.decode("{nope")
eq(bad, nil, "bad json")
assert(why, "bad json says why")
eq(Json.encode({ pluginId = "a.b", scopes = { "x", "y" } }):find('"scopes":%["x","y"%]') ~= nil, true, "encode")
eq(Json.encode({}), "[]", "empty table")

-- Keywords
local heron = { scientificName = "Ardea herodias", state = "photographed", isTarget = false, bestRating = 2 }
eq(table.concat(Keywords.forSpecies(heron, "flat"), "|"), "Ardea herodias", "flat")
eq(table.concat(Keywords.forSpecies(heron, "tree"), "|"), "Species|Ardea herodias", "tree")
local s = Keywords.statuses(heron, "tree")
eq(#s, 1, "one status")
eq(table.concat(s[1], "|"), "Lifer|needs a better photo", "needs better photo")
local wish = { scientificName = "Strix nebulosa", state = nil, isTarget = true, bestRating = nil }
local w = Keywords.statuses(wish, "flat")
eq(#w, 2, "target and lifer")
eq(w[1][1], "lifer", "lifer first")
eq(w[2][1], "target", "then target")
eq(#Keywords.statuses({ scientificName = "x y", state = "photographed", bestRating = 5 }, "flat"), 0, "good photo")

-- Search
local list = { { scientificName = "Ardea alba" }, { scientificName = "Egretta thula" }, { scientificName = "Ardea herodias" } }
eq(#Keywords.search(list, "ardea", 10), 2, "prefix")
eq(Keywords.search(list, "thula", 10)[1].scientificName, "Egretta thula", "contains")
eq(#Keywords.search(list, "", 2), 2, "limit")
print("ok")
