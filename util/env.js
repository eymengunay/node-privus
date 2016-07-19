'use strict';

// module dependencies
const path = require('path');

// configure from dotenv file
require('dotenv').config({
  silent: true,
  path: path.join(__dirname, '../.env')
});

// defaults map
let env = {
  REGISTRY: 'https://registry.npmjs.org',
  PORT: 3000,
  REPOSITORIES: null,
  GITHUB_TOKEN: null,
  SCOPE: null,
  SECRET: null
};

// iterate env variables
Object.keys(env).forEach(function(key) {
  env[key] = process.env[key] || env[key];
});

// github token is required
if (!env.GITHUB_TOKEN) throw new Error('GITHUB_TOKEN is required');

// secret is required
if (!env.SECRET) throw new Error('SECRET is required');

// parse repositories array
if (env.REPOSITORIES) env.REPOSITORIES = env.REPOSITORIES.replace(/ /g, '').split(',');

// move on
module.exports = env;
