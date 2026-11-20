Pod::Spec.new do |s|
  s.name           = 'LocalPairing'
  s.version        = '1.0.0'
  s.summary        = 'Finds Lifer on the local network and gives pairing secure random bytes'
  s.license        = 'AGPL-3.0-only'
  s.author         = 'Lifer'
  s.homepage       = 'https://github.com/Sparklysparkspark/lifer-app'
  s.platforms      = { :ios => '15.1' }
  s.source         = { :git => '' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.source_files = '*.{h,m,swift}'
end
