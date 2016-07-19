'use strict';

// module dependencies
const express = require('express');
const proxy = require('http-proxy-middleware');
const diskdb = require('diskdb');
const bodyParser = require('body-parser');
const semver = require('semver');
const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const favicon = require('serve-favicon');
const https = require('https');
const morgan = require('morgan');
const async = require('async');
const GitHubApi = require('github');
const mkdirp = require('mkdirp');
const tmp = require('tmp');
const parseLinkHeader = require('parse-link-header');
const pjson = require('./package.json');

// load environment value defaults
const env = require('./util/env');

// ensure db dir
let dbdir = path.join(__dirname, '.db');
mkdirp.sync(dbdir);

// connect to db
let collections = ['packages', 'repositories'];
let db = diskdb.connect(dbdir).loadCollections(collections);

// initialize github api
let github = new GitHubApi({
  debug: false,
  headers: {
    'user-agent': pjson.name
  },
  followRedirects: false,
  timeout: 5000
});

// github api authentication
github.authenticate({
  type: 'oauth',
  token: env.GITHUB_TOKEN
});

// check repository
let checkRepository = function(user, repo, callback) {
  return github.repos.getContent({
    user: user,
    repo: repo,
    path: 'package.json'
  }, function(err, file) {
    return callback(err, !!file);
  });
};

// process repository
let processRepository = function(user, repo, callback) {
  // ensure callback
  callback = callback || function() {};
  // set repo id
  let id = `${user}/${repo}`;
  // ensure repository
  let repository = db.repositories.findOne({ id: id });
  if (!repository) repository = db.repositories.save({
    id: id,
    user: user,
    repo: repo
  });
  // commits pagination
  let hasNext = true;
  let page = 1;
  let commits = [];
  return async.whilst(function() {
    return hasNext;
  }, function(done) {
    // get commits options
    let getCommits = {
      user: user,
      repo: repo,
      path: 'package.json',
      page: page,
      per_page: 100
    };
    // add since
    if (repository.since) getCommits.since = repository.since;
    // get commits
    return github.repos.getCommits(getCommits, function(err, results) {
      // error handler
      if (err) return done(err);
      // parse link header
      if (results.meta.link) {
        let links = parseLinkHeader(results.meta.link);
        if (!links.next) hasNext = false;
      } else {
        hasNext = false;
      }
      // merge commits
      commits = commits.concat(results);
      // next page
      page++;
      // check results
      if (results.length) {
        // parse commit date
        let date = new Date(results[0].commit.committer.date);
        // find repository
        let result = db.repositories.findOne({ id: id });
        // update since
        if (!result.since || new Date(result.since) < date) {
          db.repositories.update({ id: id }, { since: date });
        }
      }
      // move on
      return done(null, commits);
    });
  }, function (err) {
    // error handler
    if (err) {
      console.error('an error occured while processing %s/%s', user, repo);
      console.error(err);
      return callback(err);
    }
    // iterate commits
    return async.eachLimit(commits, 5, function(commit, done) {
      return github.repos.getContent({
        user: user,
        repo: repo,
        path: 'package.json',
        ref: commit.sha
      }, function(err, file) {
        // error handler
        if (err) return done(err);
        // read file content
        let content = new Buffer(file.content, 'base64');
        // parse package.json
        let pkg;
        try {
          // parse package.json content
          pkg = JSON.parse(content.toString());
          // validate package.json version
          if (!semver.valid(pkg.version)) throw new Error('invalid semver string');
        } catch (e) {
          return done(e);
        }
        // check name
        if (typeof pkg.name !== 'string') return done();
        // check scope
        if (env.SCOPE && pkg.name.indexOf(`@${env.SCOPE}`) !== 0) return done();
        // download tarball
        return new Promise(function(resolve, reject) {
          // set local tarball filename
          let filename = `./public/tarball/${pkg.name}/${pkg.version}.tgz`;
          // ensure package directory
          mkdirp.sync(path.dirname(filename));
          // check local tarball
          let exists = true;
          try {
            fs.accessSync(filename, fs.F_OK);
          } catch (e) {
            exists = false;
          }
          if (exists) {
            return resolve(filename);
          } else {
            // get download link
            return github.repos.getArchiveLink({
              user: user,
              repo: repo,
              archive_format: 'tarball',
              ref: commit.sha
            }, function(err, result) {
              // error handler
              if (err) return done(err);
              // download tarball
              let tmpName = tmp.tmpNameSync({ dir: __dirname });
              let file = fs.createWriteStream(tmpName);
              let req = https.get(result.meta.location, function(res) {
                res.pipe(file);
                res.on('error', reject);
                file.on('finish', function() {
                  fs.renameSync(tmpName, filename);
                  return resolve(filename);
                });
                file.on('error', reject);
              });
            });
          }
        }).then(function(filename) {
          // calculate checksum
          return fs.readFile(filename, function(err, contents) {
            // error handler
            if (err) return done(err);
            // set shasum
            let checksum = crypto.createHash('sha1').update(contents, 'utf8').digest('hex');
            pkg._shasum = checksum;
            // set dist
            pkg.dist = {
              shasum: checksum,
              tarball: `tarball/${pkg.name}/${pkg.version}.tgz`
            };
            // package id
            pkg.id = `${pkg.name}#v${pkg.version}`;
            pkg['dist-tags'] = { latest: pkg.version };
            // ensure package
            db.packages.remove({ id: pkg.id });
            db.packages.save(pkg);
            // move on
            return done();
          });
        }).catch(done);
      });
    }, function(err) {
      // error handler
      if (err) {
        console.error('an error occured while processing %s/%s', user, repo);
        console.error(err);
      } else {
        console.log('%s/%s processed successfully', user, repo);
      }
      // move on
      return callback(err);
    });
  });
};

// get all repositories
let loadRepos = function(callback) {
  // ensure callback
  callback = callback || function() {};
  // initialize promise
  return new Promise(function(resolve, reject) {
    // check repositories env
    if (env.REPOSITORIES && env.REPOSITORIES.length) {
      // log msg
      console.log('processing %s repositories', env.REPOSITORIES.length);
      // move on
      return resolve(env.REPOSITORIES.map(function(r) {
        // split into owner/name
        let parts = r.split('/');
        // check parts
        if (parts.length !== 2) throw new Error('invalid repository');
        // move on
        return {
          owner: parts[0],
          name: parts[1]
        };
      }));
    } else {
      // get all repositories
      return github.repos.getAll({
        per_page: 100
      }, function(err, repos) {
        // error handler
        if (err) return reject(err);
        // log msg
        console.log('processing %s repositories', repos.length);
        // move on
        return resolve(repos.map(function(r) {
          return {
            owner: r.owner.login,
            name: r.name
          };
        }));
      });
    }
  }).then(function(repos) {
    // iterate repos
    return async.eachLimit(repos, 5, function(repo, done) {
      // check for a package.json
      return checkRepository(repo.owner, repo.name, function(err, pass) {
        // error handler
        if (err) return console.error(err);
        // check pass
        if (pass) {
          // process repository
          return processRepository(repo.owner, repo.name, done);
        } else {
          // skip repository
          console.info('skipping %s/%s', repo.owner, repo.name);
          return done(null, false);
        }
      });
    }, function(err, results) {
      // error handler
      if (err) {
        console.warn('repository processing finished with error(s)');
        console.error(err);
      } else {
        console.log('repositories processed');
      }
      return callback();
    });
  }).catch(callback);
};

// initialize express application
let app = express();

// log requests
app.use(morgan('dev'));

// favicon middleware
app.use(favicon(path.join(__dirname, '/assets/favicon.ico')));

// secret parameter
app.param('secret', function(req, res, next, id) {
  // check token
  if (id === env.SECRET) {
    req.secret = id;
    return next();
  } else {
    let err = new Error('Unauthorized');
    err.status = 401;
    return next(err);
  }
});

// package parameter
app.param('package', function(req, res, next, id) {
  // find package versions
  let versions = db.packages.find({ name: id });
  // check package versions
  if (versions.length) {
    // sort versions
    versions.sort(function(a, b) {
      return semver.gt(a.version, b.version);
    });
    // generate versions object
    let versionsObj = {};
    versions.forEach(function(version) {
      // rewrite tarball
      version.dist.tarball = `${req.protocol}://${req.get('host')}/${req.secret}/${version.dist.tarball}`;
      // move on
      versionsObj[version.version] = version;
    });
    // set package
    req.package = Object.assign({}, versions[versions.length - 1]);
    // iterate package versions
    req.package.versions = versionsObj;
    // move on
    return next();
  } else {
    let err = new Error('Unauthorized');
    err.status = 404;
    return next(err);
  }
});

// get package
app.get('/:secret/:package', function(req, res, next) {
  return res.jsonp(req.package);
});

// get package version
app.get('/:secret/:package/:version', function(req, res, next) {
  // check version
  if (req.package.versions[req.params.version]) {
    return res.jsonp(req.package.versions[req.params.version]);
  } else {
    return res.status(404).jsonp({
      error: `version not found: ${req.params.version}`
    });
  }
});

// reload handler
app.post('/:secret/reload', function(req, res, next) {
  // get repositories
  loadRepos();
  // move on
  return res.status(204).end();
});

// github webhook handler
app.post('/:secret/github', bodyParser.json(), function(req, res, next) {
  // check x-github-event
  if (req.get('X-GitHub-Event') !== 'push' && req.get('X-GitHub-Event') !== 'ping') {
    let err = new Error('only push events are accepted');
    err.status = 400;
    return next(err);
  }
  // check payload
  if (!req.body.repository || !req.body.repository.owner || !req.body.repository.name) {
    let err = new Error('invalid payload');
    err.status = 400;
    return next(err);
  }
  // process repository
  processRepository(req.body.repository.owner.login, req.body.repository.name);
  // move on
  return res.status(204).end();
});

// static middleware
app.use('/:secret', express.static('./public', { redirect: false }));

// not found handler
app.use('/:secret', function(req, res, next) {
  let err = new Error('Not found');
  err.status = 404;
  return next(err);
});

// proxy handler
app.use('/:secret', function(err, req, res, next) {
  if (err.status === 404) {
    // proxy options
    let proxyOptions = {
      target: env.REGISTRY,
      changeOrigin: true,
      logLevel: 'silent'
    };
    // remove secret
    if (req.params.secret) {
      console.log(req.params.secret);
      proxyOptions.pathRewrite = {}
      proxyOptions.pathRewrite[`/${req.params.secret}`] = '/';
    }
    // proxy request
    return proxy(proxyOptions)(req, res, next);
  } else {
    return next(err);
  }
});

// unauthorized handler
app.use(function(req, res, next) {
  let err = new Error('Unauthorized');
  err.status = 401;
  return next(err);
});

// error handler
app.use(function(err, req, res, next) {
  // set response status
  err.status = err.status || 500;
  res.status(err.status);
  // move on
  return res.jsonp({
    error: err.message,
    status: err.status
  });
});

// populate db
return loadRepos(function(err) {
  // error handler
  if (err) throw err;
  // create server
  app.listen(env.PORT, function() {
    console.log('registry is listening on port %s', env.PORT);
  });
});
