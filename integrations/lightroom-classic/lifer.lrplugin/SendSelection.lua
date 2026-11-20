local LrApplication = import "LrApplication"
local LrDialogs = import "LrDialogs"
local LrExportSession = import "LrExportSession"
local LrFileUtils = import "LrFileUtils"
local LrPathUtils = import "LrPathUtils"
local LrProgressScope = import "LrProgressScope"
local LrTasks = import "LrTasks"
local LiferApi = require "LiferApi"

LrTasks.startAsyncTask(function()
  if not LiferApi.isDesktop() then
    LrDialogs.message("Send to the Lifer app", "Sending photos works with the Lifer app on this computer. For a server, import them in Lifer's own import page.", "info")
    return
  end
  local photos = LrApplication.activeCatalog():getTargetPhotos()
  if #photos == 0 then return end
  if LrDialogs.confirm("Send " .. #photos .. " photo" .. (#photos == 1 and "" or "s") .. " to Lifer?",
      "Lightroom makes full-size JPEG copies, with your keywords and ratings, and Lifer adds them and works out the species. Your Lightroom photos aren't changed.", "Send") ~= "ok" then
    return
  end

  local folder = LrPathUtils.child(LrPathUtils.getStandardFilePath("temp"), "lifer-from-lightroom-" .. os.time())
  LrFileUtils.createAllDirectories(folder)
  local session = LrExportSession {
    photosToExport = photos,
    exportSettings = {
      LR_export_destinationType = "specificFolder",
      LR_export_destinationPathPrefix = folder,
      LR_export_useSubfolder = false,
      LR_collisionHandling = "rename",
      LR_format = "JPEG",
      LR_jpeg_quality = 0.92,
      LR_size_doConstrain = false,
      LR_metadata_keywordOptions = "lightroomHierarchical",
      LR_embeddedMetadataOption = "all",
      LR_removeLocationMetadata = false,
      LR_minimizeEmbeddedMetadata = false,
      LR_reimportExportedPhoto = false,
      LR_outputSharpeningOn = false,
    },
  }
  local progress = LrProgressScope { title = "Preparing photos for Lifer" }
  local done = 0
  for _, rendition in session:renditions() do
    rendition:waitForRender()
    done = done + 1
    progress:setPortionComplete(done, #photos)
  end
  progress:done()

  local started, err = LiferApi.importFolder(folder)
  if not started then LrDialogs.message("Couldn't send to Lifer", err, "warning"); return end
  LrDialogs.message("Sent to Lifer", "Lifer is adding the photos in the background. You can keep working.", "info")
end)
