/**
 * Ensure the integrity of the packages in the repo.
 *
 * Ensure the core package version dependencies match everywhere.
 * Ensure imports match dependencies for TypeScript packages.
 * Manage the all-packages meta package.
 */
var childProcess = require('child_process');
var path = require('path');
var glob = require('glob');
var sortPackageJson = require('sort-package-json');
var ts = require("typescript");
var fs = require('fs-extra');
var getDependency = require('./get-dependency');


// Data to ignore.
var MISSING = {
  "@jupyterlab/buildutils": ["path"]
}

var UNUSED = {
  "@jupyterlab/apputils-extension": ["es6-promise"],
  "@jupyterlab/theme-dark-extension": ["font-awesome"],
  "@jupyterlab/theme-light-extension": ["font-awesome"],
  "@jupyterlab/vega2-extension": ["d3","vega","vega-lite"]
}

var pkgData = {};
var pkgPaths = {};
var pkgNames = {};
var basePath = path.resolve('.');
var localPackages = glob.sync(path.join(basePath, 'packages', '*'));
var seenDeps = {};


/**
 * Ensure the integrity of a package.
 */
function ensurePackage(pkgName) {
  var dname = pkgPaths[pkgName];
  var data = pkgData[pkgName];
  var deps = data.dependencies;
  var devDeps = data.devDependencies;
  var messages = [];

  // Verify dependencies are consistent.
  Object.keys(deps).forEach(function(name) {
    if (!(name in seenDeps)) {
      seenDeps[name] = getDependency(name);
    }
    deps[name] = seenDeps[name];
  });

  // Verify devDependencies are consistent.
  Object.keys(devDeps).forEach(function(name) {
    if (!(name in seenDeps)) {
      seenDeps[name] = getDependency(name);
    }
    devDeps[name] = seenDeps[name];
  });

  if (pkgName == '@jupyterlab/all-packages') {
    messages = messages.concat(ensureAllPackages());
  }

  // For TypeScript files, verify imports match dependencies.
  filenames = glob.sync(path.join(dname, 'src/*.ts*'));
  filenames = filenames.concat(glob.sync(path.join(dname, 'src/**/*.ts*')));

  if (filenames.length == 0) {
    if (ensurePackageData(data, path.join(dname, 'package.json'))) {
      messages.push('Package data changed');
    }
    return messages;
  }

  var imports = [];

  // Extract all of the imports from the TypeScript files.
  filenames.forEach(fileName => {
    var sourceFile = ts.createSourceFile(fileName,
        fs.readFileSync(fileName).toString(), ts.ScriptTarget.ES6,
        /*setParentNodes */ true);
    imports = imports.concat(getImports(sourceFile));
  });
  var names = Array.from(new Set(imports)).sort();
  names = names.map(function(name) {
    var parts = name.split('/');
    if (name.indexOf('@') === 0) {
      return parts[0] + '/' + parts[1];
    }
    return parts[0];
  })

  // Look for imports with no dependencies.
  names.forEach(function(name) {
    if (MISSING[pkgName] && MISSING[pkgName].indexOf(name) !== -1) {
      return;
    }
    if (name == '.' || name == '..') {
      return;
    }
    if (!deps[name]) {
      messages.push('Missing dependency: ' + name);
      if (!(name in seenDeps)) {
        seenDeps[name] = getDependency(name);
      }
      deps[name] = seenDeps[name];
    }
  });

  // Look for unused packages
  Object.keys(deps).forEach(function(name) {
    if (UNUSED[pkgName] && UNUSED[pkgName].indexOf(name) !== -1) {
      return;
    }
    if (names.indexOf(name) === -1) {
      messages.push('Unused dependency: ' + name);
      delete data.dependencies[name]
    }
  });

  if (ensurePackageData(data, path.join(dname, 'package.json'))) {
    messages.push('Package data changed');
  }
  return messages;
}


/**
 * Ensure the all-packages package.
 */
function ensureAllPackages() {
  var allPackagesPath = path.join(basePath, 'packages', 'all-packages');
  var allPackageJson = path.join(allPackagesPath, 'package.json');
  var allPackageData = require(allPackageJson);
  var tsconfigPath = path.join(
    basePath, 'packages', 'all-packages', 'tsconfig.json'
  );
  var tsconfig = require(tsconfigPath);
  var indexPath = path.join(basePath, 'packages', 'all-packages', 'src', 'index.ts');
  var index = fs.readFileSync(indexPath, 'utf8');
  var lines = index.split('\n').slice(0, 3);
  var messages = [];

  localPackages.forEach(function (pkgPath) {
    if (pkgPath === allPackagesPath) {
      return;
    }
    var name = pkgNames[pkgPath];
    var data = pkgData[name];
    var valid = true;

    // Ensure it is a dependency.
    if (!allPackageData.dependencies[name]) {
      valid = false;
      allPackageData.dependencies[name] = '^' + data.version;
    }

    // Ensure it is in index.ts
    if (index.indexOf(name) === -1) {
      valid = false;
    }
    lines.push('import "' + name + '";\n');

    if (!valid) {
      messages.push('Updated: ' + name);
    }
  });

  // Write the files.
  if (ensurePackageData(allPackageData, allPackageJson)) {
    messages.push('Package data changed');
  }
  var newIndex = lines.join('\n');
  if (newIndex != index) {
    messages.push('Index changed');
    fs.writeFileSync(indexPath, lines.join('\n'));
  }

  return messages;
}


/**
 * Extract the module imports from a TypeScript source file.
 */
function getImports(sourceFile) {
    var imports = [];
    handleNode(sourceFile);

    function handleNode(node) {
        switch (node.kind) {
            case ts.SyntaxKind.ImportDeclaration:
                imports.push(node.moduleSpecifier.text);
                break;
            case ts.SyntaxKind.ImportEqualsDeclaration:
                imports.push(node.moduleReference.expression.text);
                break;
        }
        ts.forEachChild(node, handleNode);
    }
    return imports;
}


/**
 * Write package data using sort-package-json.
 */
function ensurePackageData(data, pkgJsonPath) {
  var text = JSON.stringify(sortPackageJson(data), null, 2) + '\n';
  var orig = fs.readFileSync(pkgJsonPath).toString();
  if (text !== orig) {
    fs.writeFileSync(pkgJsonPath, text);
    return true;
  }
  return false;
}


/**
 * Ensure the top level package.
 */
function ensureTop() {
  // Hoist dependencies and devDependencies to top level.
  var localPath = path.join(basePath, 'package.json');
  var localData = require(localPath);
  localPackages.forEach(function (pkgPath) {
    var name = pkgNames[pkgPath];
    var data = pkgData[name];
    var devDeps = data.devDependencies || {};
    Object.keys(devDeps).forEach(function (name) {
      localData.devDependencies[name] = devDeps[name];
    });
  });
  if (ensurePackageData(localData, localPath)) {
    return 'updated';
  }
}


/**
 * Ensure the repo integrity.
 */
function ensureIntegrity() {
  var messages = {};

  // Look in all of the packages.
  var lernaConfig = require(path.join(basePath, 'lerna.json'));
  var paths = [];
  for (let spec of lernaConfig.packages) {
    paths = paths.concat(glob.sync(path.join(basePath, spec)));
  }

  // Pick up all the package versions.
  paths.forEach(function(pkgPath) {
    pkgPath = path.resolve(pkgPath);
    // Read in the package.json.
    try {
      var package = require(path.join(pkgPath, 'package.json'));
    } catch (e) {
      return;
    }

    pkgData[package.name] = package;
    pkgPaths[package.name] = pkgPath;
    pkgNames[pkgPath] = package.name;
  });

  // Handle the top level package.
  var topMessage = ensureTop();
  if (topMessage) {
    messages['top'] = topMessage;
  }

  // Validate each package.
  for (let name in pkgData) {
    var pkgMessages = ensurePackage(name);
    if (pkgMessages.length > 0) {
      messages[name] = pkgMessages;
    }
  };

  // Handle any messages.
  if (Object.keys(messages).length > 0) {
    console.log(JSON.stringify(messages, null, 2));
    if (process.env.TRAVIS_BRANCH) {
      console.log('\n\nPlease run `npm run integrity` locally and commit the changes');
    } else {
      console.log('\n\nPlease commit the changes by running:');
      console.log('git commit -a -m "Package integrity updates"')
    }
    process.exit(1);
  } else {
    console.log('Repo integrity verified!');
  }
}

ensureIntegrity();
