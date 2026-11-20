-- Just enough JSON for Lifer's answers and requests: no streaming, no comments.
local Json = {}

local escapes = { ['"'] = '\\"', ["\\"] = "\\\\", ["\b"] = "\\b", ["\f"] = "\\f", ["\n"] = "\\n", ["\r"] = "\\r", ["\t"] = "\\t" }

local function quote(s)
  return '"' .. s:gsub('[%c"\\]', function(c)
    return escapes[c] or string.format("\\u%04x", c:byte())
  end) .. '"'
end

function Json.encode(value)
  local kind = type(value)
  if kind == "nil" then return "null" end
  if kind == "boolean" or kind == "number" then return tostring(value) end
  if kind == "string" then return quote(value) end
  if kind ~= "table" then error("can't encode a " .. kind) end
  if #value > 0 or next(value) == nil then
    local parts = {}
    for i, v in ipairs(value) do parts[i] = Json.encode(v) end
    return "[" .. table.concat(parts, ",") .. "]"
  end
  local parts = {}
  for k, v in pairs(value) do parts[#parts + 1] = quote(tostring(k)) .. ":" .. Json.encode(v) end
  return "{" .. table.concat(parts, ",") .. "}"
end

local function utf8char(code)
  if code < 0x80 then return string.char(code) end
  if code < 0x800 then return string.char(0xC0 + math.floor(code / 64), 0x80 + code % 64) end
  return string.char(0xE0 + math.floor(code / 4096), 0x80 + math.floor(code / 64) % 64, 0x80 + code % 64)
end

-- Returns the decoded value, or nil and a message for text that isn't JSON.
function Json.decode(text)
  local pos = 1
  local function fail(why) error({ json = why .. " at " .. pos }, 0) end
  local function skip() pos = text:find("[^ \t\r\n]", pos) or #text + 1 end
  local value

  local function str()
    local out = {}
    pos = pos + 1
    while true do
      local c = text:sub(pos, pos)
      if c == "" then fail("unterminated string") end
      if c == '"' then pos = pos + 1; return table.concat(out) end
      if c == "\\" then
        local e = text:sub(pos + 1, pos + 1)
        if e == "u" then
          out[#out + 1] = utf8char(tonumber(text:sub(pos + 2, pos + 5), 16) or fail("bad escape"))
          pos = pos + 6
        else
          local map = { b = "\b", f = "\f", n = "\n", r = "\r", t = "\t" }
          out[#out + 1] = map[e] or e
          pos = pos + 2
        end
      else
        out[#out + 1] = c
        pos = pos + 1
      end
    end
  end

  function value()
    skip()
    local c = text:sub(pos, pos)
    if c == "{" then
      local obj = {}
      pos = pos + 1
      skip()
      if text:sub(pos, pos) == "}" then pos = pos + 1; return obj end
      while true do
        skip()
        if text:sub(pos, pos) ~= '"' then fail("expected a key") end
        local key = str()
        skip()
        if text:sub(pos, pos) ~= ":" then fail("expected :") end
        pos = pos + 1
        obj[key] = value()
        skip()
        local d = text:sub(pos, pos)
        pos = pos + 1
        if d == "}" then return obj end
        if d ~= "," then fail("expected , or }") end
      end
    elseif c == "[" then
      local list = {}
      pos = pos + 1
      skip()
      if text:sub(pos, pos) == "]" then pos = pos + 1; return list end
      while true do
        list[#list + 1] = value()
        skip()
        local d = text:sub(pos, pos)
        pos = pos + 1
        if d == "]" then return list end
        if d ~= "," then fail("expected , or ]") end
      end
    elseif c == '"' then
      return str()
    elseif text:sub(pos, pos + 3) == "true" then
      pos = pos + 4
      return true
    elseif text:sub(pos, pos + 4) == "false" then
      pos = pos + 5
      return false
    elseif text:sub(pos, pos + 3) == "null" then
      pos = pos + 4
      return nil
    end
    local number = text:match("^-?%d+%.?%d*[eE]?[+-]?%d*", pos)
    if not number or number == "" then fail("unexpected character") end
    pos = pos + #number
    return tonumber(number)
  end

  local ok, result = pcall(value)
  if not ok then
    if type(result) == "table" and result.json then return nil, result.json end
    error(result, 0)
  end
  return result
end

return Json
