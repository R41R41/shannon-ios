#!/usr/bin/env ruby
# frozen_string_literal: true

require 'fileutils'
require 'xcodeproj'

repo = File.expand_path('..', __dir__)
project_path = File.join(repo, 'apps/macos-app/ShannonDesk.xcodeproj')
package_resolved_path = File.join(
  project_path,
  'project.xcworkspace/xcshareddata/swiftpm/Package.resolved'
)
package_resolved = File.binread(package_resolved_path) if File.exist?(package_resolved_path)
source_root = File.join(repo, 'apps/macos-app/ShannonDesk')
source_paths = Dir[File.join(source_root, '**/*.swift')].sort
test_paths = Dir[File.join(repo, 'apps/macos-app/ShannonDeskTests/*.swift')].sort

abort 'Missing Shannon Desk sources' if source_paths.empty?
abort 'Missing Shannon Desk tests' if test_paths.empty?

FileUtils.rm_rf(project_path)
project = Xcodeproj::Project.new(project_path)
project.root_object.attributes['LastSwiftUpdateCheck'] = '2660'
project.root_object.attributes['LastUpgradeCheck'] = '2660'
project.root_object.development_region = 'ja'

target = project.new_target(:application, 'ShannonDesk', :osx, '14.0')
target.product_name = 'ShannonDesk'

app_group = project.main_group.new_group('ShannonDesk', 'ShannonDesk')
app_group.new_file('Info.plist')
app_group.new_file('ShannonDesk.entitlements')
asset_catalog = app_group.new_file('Assets.xcassets')
target.resources_build_phase.add_file_reference(asset_catalog)
source_references = {}
source_paths.each do |path|
  source = app_group.new_file(path.delete_prefix("#{source_root}/"))
  source_references[File.basename(path)] = source
  target.source_build_phase.add_file_reference(source)
end

test_target = project.new_target(:unit_test_bundle, 'ShannonDeskTests', :osx, '14.0')
test_group = project.main_group.new_group('ShannonDeskTests', 'ShannonDeskTests')
test_paths.each do |path|
  source = test_group.new_file(File.basename(path))
  test_target.source_build_phase.add_file_reference(source)
end
%w[ShannonDesktopAttachment.swift ShannonDesktopSupport.swift].each do |name|
  test_target.source_build_phase.add_file_reference(source_references.fetch(name))
end

package = project.new(Xcodeproj::Project::Object::XCLocalSwiftPackageReference)
package.relative_path = '../ios'
project.root_object.package_references << package

product = project.new(Xcodeproj::Project::Object::XCSwiftPackageProductDependency)
product.package = package
product.product_name = 'ShannonAppCore'
target.package_product_dependencies << product

framework = project.new(Xcodeproj::Project::Object::PBXBuildFile)
framework.product_ref = product
target.frameworks_build_phase.files << framework

test_product = project.new(Xcodeproj::Project::Object::XCSwiftPackageProductDependency)
test_product.package = package
test_product.product_name = 'ShannonAppCore'
test_target.package_product_dependencies << test_product

test_framework = project.new(Xcodeproj::Project::Object::PBXBuildFile)
test_framework.product_ref = test_product
test_target.frameworks_build_phase.files << test_framework

target.build_configurations.each do |configuration|
  settings = configuration.build_settings
  settings['ASSETCATALOG_COMPILER_APPICON_NAME'] = 'AppIcon'
  settings['ASSETCATALOG_COMPILER_GLOBAL_ACCENT_COLOR_NAME'] = 'AccentColor'
  settings['ASSETCATALOG_COMPILER_STANDALONE_ICON_BEHAVIOR'] = 'all'
  settings['CODE_SIGN_ENTITLEMENTS'] = 'ShannonDesk/ShannonDesk.entitlements'
  settings['CODE_SIGN_STYLE'] = 'Automatic'
  settings['CURRENT_PROJECT_VERSION'] = '5'
  settings['DEVELOPMENT_TEAM'] = '66TZ23L7ZJ'
  settings['ENABLE_APP_SANDBOX'] = 'YES'
  settings['ENABLE_HARDENED_RUNTIME'] = 'YES'
  settings['GENERATE_INFOPLIST_FILE'] = 'NO'
  settings['INFOPLIST_FILE'] = 'ShannonDesk/Info.plist'
  settings['LD_RUNPATH_SEARCH_PATHS'] = ['$(inherited)', '@executable_path/../Frameworks']
  settings['MACOSX_DEPLOYMENT_TARGET'] = '14.0'
  settings['MARKETING_VERSION'] = '0.1.0'
  settings['PRODUCT_BUNDLE_IDENTIFIER'] = 'com.r41r41.shannon'
  settings['PRODUCT_NAME'] = '$(TARGET_NAME)'
  settings['SHANNON_API_BASE_URL'] = 'https://sh4nnon.com/companion'
  settings['SHANNON_API_TOKEN'] = ''
  settings['SWIFT_EMIT_LOC_STRINGS'] = 'YES'
  settings['SWIFT_STRICT_CONCURRENCY'] = 'complete'
  settings['SWIFT_VERSION'] = '6.0'
end

test_target.build_configurations.each do |configuration|
  settings = configuration.build_settings
  settings['CODE_SIGN_STYLE'] = 'Automatic'
  settings['DEVELOPMENT_TEAM'] = '66TZ23L7ZJ'
  settings['GENERATE_INFOPLIST_FILE'] = 'YES'
  settings['MACOSX_DEPLOYMENT_TARGET'] = '14.0'
  settings['PRODUCT_BUNDLE_IDENTIFIER'] = 'com.r41r41.shannon.macos.tests'
  settings['SWIFT_STRICT_CONCURRENCY'] = 'complete'
  settings['SWIFT_VERSION'] = '6.0'
end

project.save

if package_resolved
  FileUtils.mkdir_p(File.dirname(package_resolved_path))
  File.binwrite(package_resolved_path, package_resolved)
end

scheme = Xcodeproj::XCScheme.new
scheme.add_build_target(target)
scheme.add_test_target(test_target)
scheme.set_launch_target(target)
scheme.save_as(project_path, 'ShannonDesk', true)

puts "Generated #{project_path}"
