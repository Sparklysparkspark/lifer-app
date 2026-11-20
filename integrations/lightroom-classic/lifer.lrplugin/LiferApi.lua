-- Everything that talks to Lifer. One address, the one the user typed in Connect (the Lifer
-- desktop app on this computer by default, or their own server), and only Lifer's public routes
-- with the scoped key Lifer issued. Nothing here contacts any other host.
local LrHttp = import "LrHttp"
local LrPasswords = import "LrPasswords"
local LrPrefs = import "LrPrefs"
local LrTasks = import "LrTasks"
local Json = require "Json"

local LiferApi = {}

LiferApi.PLUGIN_ID = "app.lifer.lightroom-classic"
LiferApi.PLUGIN_NAME = "Lifer for Lightroom Classic"
LiferApi.SCOPES = { "userdata.read", "imports.write" }
LiferApi.DEFAULT_ADDRESS = "http://127.0.0.1:4310"

local KEY_NAME = "lifer-api-key"

local function prefs()
  local p = LrPrefs.prefsForPlugin()
  if p.address == nil then p.address = LiferApi.DEFAULT_ADDRESS end
  if p.layout == nil then p.layout = "tree" end
  return p
end

LiferApi.prefs = prefs

function LiferApi.address()
  return (prefs().address:gsub("/+$", ""))
end

-- The desktop app answers on this computer; a server pairs with a code from its settings.
function LiferApi.isDesktop()
  local a = LiferApi.address()
  return a:find("^https?://127%.0%.0%.1[:/]") ~= nil or a:find("^https?://127%.0%.0%.1$") ~= nil
    or a:find("^https?://localhost[:/]") ~= nil or a:find("^https?://localhost$") ~= nil
end

function LiferApi.key()
  return LrPasswords.retrieve(KEY_NAME, LiferApi.address())
end

function LiferApi.saveKey(key)
  LrPasswords.store(KEY_NAME, key, LiferApi.address())
end

function LiferApi.forgetKey()
  LrPasswords.store(KEY_NAME, "", LiferApi.address())
end

local function statusOf(headers)
  return headers and headers.status or 0
end

-- Returns the decoded answer, or nil and a sentence the user can read.
local function call(method, route, body, withKey)
  local headers = { { field = "Content-Type", value = "application/json" }, { field = "x-lifer-client", value = "1" } }
  if withKey then
    local key = LiferApi.key()
    if not key or key == "" then return nil, "Connect to Lifer first (Library > Plug-in Extras > Connect to Lifer)." end
    headers[#headers + 1] = { field = "x-api-key", value = key }
  end
  local url = LiferApi.address() .. route
  local text, info
  if method == "GET" then
    text, info = LrHttp.get(url, headers, 30)
  else
    text, info = LrHttp.post(url, Json.encode(body or {}), headers, method, 600)
  end
  local status = statusOf(info)
  if status == 0 or text == nil then
    return nil, "Lifer didn't answer at " .. LiferApi.address() .. ". Is Lifer open?"
  end
  local data = Json.decode(text)
  if status == 401 then return nil, "Lifer no longer accepts this connection. Connect again." end
  if status >= 400 then
    return nil, (type(data) == "table" and data.error) or ("Lifer said no (" .. tostring(status) .. ").")
  end
  return data or {}
end

LiferApi.call = call

-- Desktop: ask Lifer to show a code and wait for the user to Allow it in Lifer's window.
-- `onCode` is told the code to show; `cancelled` is polled between checks.
function LiferApi.pairOnDesktop(onCode, cancelled)
  local started, err = call("POST", "/api/plugins/v1/pair-requests", {
    pluginId = LiferApi.PLUGIN_ID,
    name = LiferApi.PLUGIN_NAME,
    scopes = LiferApi.SCOPES,
  }, false)
  if not started then return nil, err end
  onCode(started.code)
  while not cancelled() do
    LrTasks.sleep(1.5)
    local status, problem = call("GET", "/api/plugins/v1/pair-requests/" .. started.id, nil, false)
    if not status then return nil, problem end
    if status.status == "approved" then
      LiferApi.saveKey(status.key)
      return true
    elseif status.status == "denied" then
      return nil, "Lifer said no. Nothing was connected."
    elseif status.status == "expired" then
      return nil, "That request ran out of time. Try again."
    end
  end
  return nil, "Cancelled."
end

-- Server: the code comes from the server's Settings > Connected apps > Pair an app.
function LiferApi.pairWithCode(code)
  local paired, err = call("POST", "/api/plugins/v1/pair", {
    pluginId = LiferApi.PLUGIN_ID,
    name = LiferApi.PLUGIN_NAME,
    scopes = LiferApi.SCOPES,
    code = code,
  }, false)
  if not paired then return nil, err end
  LiferApi.saveKey(paired.key)
  return true
end

-- Every species the user has marked or photographed, deletions left out.
function LiferApi.species()
  local out, cursor = {}, nil
  repeat
    local route = "/api/userdata/v1/species?limit=500"
    if cursor then route = route .. "&cursor=" .. cursor end
    local page, err = call("GET", route, nil, true)
    if not page then return nil, err end
    for _, item in ipairs(page.items or {}) do
      if item.deletedAt == nil then out[#out + 1] = item end
    end
    cursor = page.nextCursor
  until cursor == nil
  return out
end

-- Asks Lifer (desktop only) to import a folder; it copies the files and works in the background.
function LiferApi.importFolder(path)
  return call("POST", "/api/imports/v1/folders", { path = path, mode = "copy" }, true)
end

return LiferApi
