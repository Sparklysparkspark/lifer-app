return {
  LrSdkVersion = 6.0,
  LrSdkMinimumVersion = 6.0,
  LrToolkitIdentifier = "app.lifer.lightroom-classic",
  LrPluginName = "Lifer",
  LrPluginInfoProvider = "PluginInfo.lua",
  LrLibraryMenuItems = {
    { title = "Tag selection with a Lifer species...", file = "TagSelection.lua", enabledWhen = "photosSelected" },
    { title = "Send selection to Lifer...", file = "SendSelection.lua", enabledWhen = "photosSelected" },
    { title = "Connect to Lifer...", file = "Connect.lua" },
  },
  VERSION = { major = 1, minor = 0, revision = 0 },
}
