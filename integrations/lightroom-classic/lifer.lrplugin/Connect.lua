local LrDialogs = import "LrDialogs"
local LrFunctionContext = import "LrFunctionContext"
local LrBinding = import "LrBinding"
local LrTasks = import "LrTasks"
local LrView = import "LrView"
local LiferApi = require "LiferApi"

local function connect(context)
  local f = LrView.osFactory()
  local props = LrBinding.makePropertyTable(context)
  props.address = LiferApi.prefs().address
  props.code = ""
  props.message = ""
  props.busy = false
  local cancelled = false

  local function work()
    LiferApi.prefs().address = props.address
    props.busy = true
    local ok, err
    if LiferApi.isDesktop() then
      ok, err = LiferApi.pairOnDesktop(function(code)
        props.message = "In Lifer, check that the code is " .. code .. " and choose Allow."
      end, function() return cancelled end)
    else
      ok, err = LiferApi.pairWithCode(props.code)
    end
    props.busy = false
    if ok then
      LrDialogs.message("Connected to Lifer", "You can now tag and send photos from Library > Plug-in Extras.", "info")
    elseif err ~= "Cancelled." then
      props.message = err
    end
  end

  local contents = f:column {
    spacing = f:control_spacing(),
    bind_to_object = props,
    f:static_text { title = "Lifer address", font = "<system/bold>" },
    f:edit_field { value = LrView.bind "address", width_in_chars = 36 },
    f:static_text {
      title = "The Lifer app on this computer is http://127.0.0.1:4310. For your own server, use its address and a pairing code from Settings > Connected apps.",
      width = 420, height_in_lines = 3,
    },
    f:row {
      f:static_text { title = "Pairing code (servers only)" },
      f:edit_field { value = LrView.bind "code", width_in_chars = 8 },
    },
    f:static_text { title = LrView.bind "message", width = 420, height_in_lines = 2 },
    f:push_button {
      title = "Connect",
      enabled = LrView.bind { key = "busy", transform = function(v) return not v end },
      action = function() LrTasks.startAsyncTask(work) end,
    },
  }
  local result = LrDialogs.presentModalDialog { title = "Connect to Lifer", contents = contents, actionVerb = "Done", cancelVerb = "< exclude >" }
  cancelled = true
  return result
end

LrFunctionContext.callWithContext("liferConnect", connect)
