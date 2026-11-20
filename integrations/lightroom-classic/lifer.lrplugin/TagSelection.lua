local LrApplication = import "LrApplication"
local LrBinding = import "LrBinding"
local LrDialogs = import "LrDialogs"
local LrFunctionContext = import "LrFunctionContext"
local LrProgressScope = import "LrProgressScope"
local LrTasks = import "LrTasks"
local LrView = import "LrView"
local LiferApi = require "LiferApi"
local Keywords = require "Keywords"

local MAX_SHOWN = 50

-- Finds or makes a keyword path like { "Species", "Ardea herodias" }.
local function keywordAt(catalog, names)
  local parent
  for _, name in ipairs(names) do
    parent = catalog:createKeyword(name, {}, true, parent, true)
  end
  return parent
end

local function chooseSpecies(list)
  local result
  LrFunctionContext.callWithContext("liferPick", function(context)
    local f = LrView.osFactory()
    local props = LrBinding.makePropertyTable(context)
    props.query = ""
    props.rating = false
    local function refresh()
      local items = {}
      for _, s in ipairs(Keywords.search(list, props.query, MAX_SHOWN)) do
        items[#items + 1] = { title = s.scientificName, value = s }
      end
      props.items = items
      props.pick = items[1] and items[1].value or nil
    end
    refresh()
    props:addObserver("query", refresh)
    local contents = f:column {
      spacing = f:control_spacing(),
      bind_to_object = props,
      f:edit_field { value = LrView.bind "query", immediate = true, width_in_chars = 36 },
      f:popup_menu { items = LrView.bind "items", value = LrView.bind "pick", width_in_chars = 36 },
      f:checkbox { title = "Give unrated photos Lifer's best star rating for this species", value = LrView.bind "rating" },
    }
    if LrDialogs.presentModalDialog { title = "Tag selection with a Lifer species", contents = contents, actionVerb = "Tag" } == "ok" then
      result = { species = props.pick, copyRating = props.rating }
    end
  end)
  return result
end

LrTasks.startAsyncTask(function()
  local list, err = LiferApi.species()
  if not list then LrDialogs.message("Couldn't reach Lifer", err, "warning"); return end
  if #list == 0 then LrDialogs.message("Nothing to tag yet", "Lifer has no species marked or photographed yet.", "info"); return end
  local choice = chooseSpecies(list)
  if not choice or not choice.species then return end

  local layout = LiferApi.prefs().layout
  local catalog = LrApplication.activeCatalog()
  local photos = catalog:getTargetPhotos()
  local progress = LrProgressScope { title = "Tagging with " .. choice.species.scientificName }
  catalog:withWriteAccessDo("Tag with Lifer species", function()
    local wanted = { Keywords.forSpecies(choice.species, layout) }
    for _, status in ipairs(Keywords.statuses(choice.species, layout)) do wanted[#wanted + 1] = status end
    local keywords = {}
    for _, names in ipairs(wanted) do keywords[#keywords + 1] = keywordAt(catalog, names) end
    for i, photo in ipairs(photos) do
      for _, keyword in ipairs(keywords) do photo:addKeyword(keyword) end
      if choice.copyRating and choice.species.bestRating and not photo:getRawMetadata("rating") then
        photo:setRawMetadata("rating", choice.species.bestRating)
      end
      progress:setPortionComplete(i, #photos)
    end
  end)
  progress:done()
end)
