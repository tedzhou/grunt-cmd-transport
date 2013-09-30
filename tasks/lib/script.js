exports.init = function (grunt) {
	var path = require('path');
	var ast = require('cmd-util').ast;
	var iduri = require('cmd-util').iduri;
	var _ = grunt.util._;


	var exports = {};

	exports.jsParser = function (fileObj, options) {
		grunt.log.verbose.writeln('Transport ' + fileObj.src + ' -> ' + fileObj.dest);
		var astCache, data = fileObj.srcData || grunt.file.read(fileObj.src);
		try {
			astCache = ast.getAst(data);
		} catch (e) {
			grunt.log.error('js parse error ' + fileObj.src.red);
			grunt.fail.fatal(e.message + ' [ line:' + e.line + ', col:' + e.col + ', pos:' + e.pos + ' ]');
		}

		var meta = ast.parseFirst(astCache);

		if (!meta) {
			if (!options.ignoreNotCmd) {
				grunt.fail.warn('found non cmd module "' + fileObj.src + '"');
				// do nothing
				return;
			} else {
				// copy directly
				grunt.file.write(fileObj.dest, data);
				grunt.log.warn('found non cmd module "' + fileObj.src + '"');
				return;
			}
		}

		if (meta.id) {
			grunt.log.verbose.writeln('id exists in "' + fileObj.src + '"');
		}

		var deps, depsSpecified = false;
		if (meta.dependencyNode) {
			deps = meta.dependencies;
			depsSpecified = true;
			grunt.log.verbose.writeln('dependencies exists in "' + fileObj.src + '"');
		} else {
			deps = parseDependencies(fileObj.src, options);
			grunt.log.verbose.writeln(deps.length ?
				'found dependencies ' + deps : 'found no dependencies');
		}

		// create .js file
		astCache = ast.modify(astCache, {
			id: meta.id ? meta.id : unixy(options.idleading + fileObj.name.replace(/\.js$/, '')),
			dependencies: deps,
			require: function (v) {
				// ignore when deps is specified by developer
				return depsSpecified ? v : iduri.parseAlias(options, v);
			}
		});


		if(options.async) {
			// 拿到这个文件未经加工的异步依赖
			var asyncRequires = ast.getAsyncRequires(astCache);
			asyncRequires.forEach(function (r) {
				r.dependencies.forEach(function (d) {
					if (d.charAt(0) === '.') {
						d = path.join(path.dirname(fileObj.src), d);
						d = path.normalize(d);
						r.dependencies = grunt.util._.union(r.dependencies, parseDependencies(d, options));
					} else {
						r.dependencies = grunt.util._.union(r.dependencies, moduleDependencies(d, options));
					}
				});
			});

			// 改ast
			for (var i = asyncRequires.length - 1; i >= 0; i--) {
				astCache = ast.modifyAsyncRequire(astCache, asyncRequires[i].requireNode, {
					dependencies: asyncRequires[i].dependencies
				});
			}
		}

		data = astCache.print_to_string(options.uglify);
		grunt.file.write(fileObj.dest, addOuterBoxClass(data, options));
		// create -debug.js file
		if (!options.debug) {
			return;
		}
		var dest = fileObj.dest.replace(/\.js$/, '-debug.js');

		astCache = ast.modify(data, function (v) {
			var ext = path.extname(v);
			if (ext && options.parsers[ext]) {
				return v.replace(new RegExp('\\' + ext + '$'), '-debug' + ext);
			} else {
				return v + '-debug';
			}
		});
		data = astCache.print_to_string(options.uglify);
		grunt.file.write(dest, addOuterBoxClass(data, options));
	};


	// helpers
	// ----------------
	function unixy(uri) {
		return uri.replace(/\\/g, '/');
	}

	function addOuterBoxClass(data, options) {
		// ex. arale/widget/1.0.0/ => arale-widget-1_0_0
		var styleId = unixy((options || {}).idleading || '')
			.replace(/\/$/, '')
			.replace(/\//g, '-')
			.replace(/\./g, '_');
		if (options.styleBox === true && styleId) {
			data = data.replace(/(\}\)[;\n\r ]*$)/, 'module.exports.outerBoxClass="' + styleId + '";$1');
		}
		return data;
	}

	var moduleDeps = {};

	function moduleDependencies(id, options) {
		if (moduleDeps[id]) {
			return moduleDeps[id];
		}
		var alias = iduri.parseAlias(options, id);

		if (iduri.isAlias(options, id) && alias === id) {
			// usually this is "$"
			return [];
		}

		// don't resolve text!path/to/some.xx, same as seajs-text
		if (/^text!/.test(id)) {
			return [];
		}

		var file = iduri.appendext(alias);

		if (!/\.js$/.test(file)) {
			return [];
		}

		var fpath;
		options.paths.some(function (base) {
			var filepath = path.join(base, file);
			if (grunt.file.exists(filepath)) {
				grunt.log.verbose.writeln('find module "' + filepath + '"');
				fpath = filepath;
				return true;
			}
		});

		if (!fpath) {
			if (!options.ignoreNotExistFile) {
				grunt.fail.warn("can't find module " + alias);
			} else {
				grunt.log.warn("can't find module " + alias);
			}
			return [];
		}
		if (!grunt.file.exists(fpath)) {
			if (!options.ignoreNotExistFile) {
				grunt.fail.warn("can't find module " + alias);
			} else {
				grunt.log.warn("can't find module " + alias);
			}
			return [];
		}
		var data = grunt.file.read(fpath);
		var parsed = ast.parse(data);
		var deps = [];

		var ids = parsed.map(function (meta) {
			return meta.id;
		});

		parsed.forEach(function (meta) {
			meta.dependencies.forEach(function (dep) {
				dep = iduri.absolute(alias, dep);
				if (!_.contains(deps, dep) && !_.contains(ids, dep) && !_.contains(ids, dep.replace(/\.js$/, ''))) {
					deps.push(dep);
				}
				// recursion
				deps = grunt.util._.union(deps, moduleDependencies(dep, options));
			});
		});

		// cache it
		moduleDeps[id] = deps;
		return deps;
	}

	function parseDependencies(fpath, options) {
		var rootpath = fpath;

		function relativeDependencies(fpath, options, basefile) {
			if (basefile) {
				fpath = path.join(path.dirname(basefile), fpath);
			}
			fpath = iduri.appendext(fpath);

			var deps = [];

			if (!grunt.file.exists(fpath)) {
				if (!/\{\w+\}/.test(fpath)) {
					grunt.log.warn("can't find " + fpath);
				}
				return [];
			}
			var parsed, data = grunt.file.read(fpath);
			try {
				parsed = ast.parseFirst(data);
			} catch (e) {
				grunt.log.error(e.message + ' [ line:' + e.line + ', col:' + e.col + ', pos:' + e.pos + ' ]');
				return [];
			}
			parsed.dependencies.map(function (id) {
				return id.replace(/\.js$/, '');
			}).forEach(function (id) {

					if (id.charAt(0) === '.') {
						// fix nested relative dependencies
						if (basefile) {
							var altId = path.join(path.dirname(fpath), id);
							altId = path.relative(path.dirname(rootpath), altId);
							altId = altId.replace(/\\/g, '/');
							if (altId.charAt(0) !== '.') {
								altId = './' + altId;
							}
							deps.push(altId);
						} else {
							deps.push(id);
						}
						if (/\.js$/.test(iduri.appendext(id))) {
							deps = grunt.util._.union(deps, relativeDependencies(id, options, fpath));
						}
					} else {
						var alias = iduri.parseAlias(options, id);
						deps.push(alias);

						// don't parse no javascript dependencies
						var ext = path.extname(alias);
						if (ext && ext !== '.js') return;

						var mdeps = moduleDependencies(id, options);
						deps = grunt.util._.union(deps, mdeps);
					}
				});
			return deps;
		}

		return relativeDependencies(fpath, options);
	}

	return exports;
};
