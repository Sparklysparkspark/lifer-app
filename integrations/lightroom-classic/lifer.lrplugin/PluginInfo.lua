local LrView = import "LrView"
local LiferApi = require "LiferApi"

local function sectionsForTopOfDialog(f, _)
  local prefs = LiferApi.prefs()
  local bind = LrView.bind
  return {
    {
      title = "Lifer",
      bind_to_object = prefs,
      f:static_text {
        title = "Species keywords use the scientific name. Choose how they are filed in Lightroom's keyword list.",
        width = 420, height_in_lines = 2,
      },
      f:radio_button { title = "In a Species list (Species > Ardea herodias)", value = bind "layout", checked_value = "tree" },
      f:radio_button { title = "Flat (Ardea herodias)", value = bind "layout", checked_value = "flat" },
      f:static_text { title = "Connected to: " .. LiferApi.address(), width = 420 },
    },
  }
end

return { sectionsForTopOfDialog = sectionsForTopOfDialog }
