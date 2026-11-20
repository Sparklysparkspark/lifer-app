-- Which keywords a Lifer species earns, in the layout the user chose. Pure, so it runs outside
-- Lightroom. Names are the scientific name only: Lifer's own files carry it as a plain keyword,
-- so Lifer matches it again when the photo comes back, and a plugin key never sees common names.
local Keywords = {}

Keywords.LAYOUT_FLAT = "flat"
Keywords.LAYOUT_TREE = "tree"
Keywords.SPECIES_ROOT = "Species"
Keywords.STATUS_ROOT = "Lifer"
Keywords.BEST_ENOUGH = 3

local function path(layout, root, name)
  if layout == Keywords.LAYOUT_TREE then return { root, name } end
  return { name }
end

-- A keyword is a list of names from the top of the tree down; flat keywords have one name.
function Keywords.forSpecies(species, layout)
  return path(layout, Keywords.SPECIES_ROOT, species.scientificName)
end

-- "lifer" while the species hasn't been photographed, "target" for a target, and "needs a better
-- photo" when the best photo of a photographed species is under three stars or unrated.
function Keywords.statuses(species, layout)
  local found = {}
  local function add(name) found[#found + 1] = path(layout, Keywords.STATUS_ROOT, name) end
  if species.state ~= "photographed" then add("lifer") end
  if species.isTarget then add("target") end
  if species.state == "photographed" and (species.bestRating == nil or species.bestRating < Keywords.BEST_ENOUGH) then
    add("needs a better photo")
  end
  return found
end

-- Species matching a typed search, scientific name only, best matches first, capped.
function Keywords.search(list, query, limit)
  local needle = query:lower():gsub("^%s+", ""):gsub("%s+$", "")
  local starts, contains = {}, {}
  for _, species in ipairs(list) do
    local name = species.scientificName:lower()
    if needle == "" or name:sub(1, #needle) == needle then
      starts[#starts + 1] = species
    elseif name:find(needle, 1, true) then
      contains[#contains + 1] = species
    end
  end
  local out = {}
  for _, group in ipairs({ starts, contains }) do
    for _, species in ipairs(group) do
      if #out >= limit then return out end
      out[#out + 1] = species
    end
  end
  return out
end

return Keywords
