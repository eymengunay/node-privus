# Privus

A private npm registry for GitHub repositories.

[![Deploy to Heroku][heroku-btn-image]][heroku-btn-url]

## Getting started

You need to set required environment variables before starting the server:

```
$ SECRET=my-secret-key
$ GITHUB_TOKEN=github-access-token
```

```
$ node index.js
```

## Environment variables

| Name                            | Default value              | Required |
|---------------------------------|----------------------------|----------|
| SECRET                          |                            | ✔        |
| GITHUB_TOKEN                    |                            | ✔        |
| PORT                            | 3000                       | ✖        |
| REGISTRY                        | https://registry.npmjs.org | ✖        |  
| SCOPE                           |                            | ✖        |
| REPOSITORIES                    |                            | ✖        |

### SECRET

Secret token needed to access registry:

`http://registry.example.com/my-secret-key`

### GITHUB_TOKEN

GitHub API access token. For more information see:

https://help.github.com/articles/creating-an-access-token-for-command-line-use/

### SCOPE

If set, only packages with given scope will be accepted.

### REPOSITORIES

If set, only given repositories will be processed. By default all repositories are processed.

[node-url]: https://nodejs.org
[npm-url]: https://npmjs.org
[heroku-btn-image]: https://www.herokucdn.com/deploy/button.svg
[heroku-btn-url]: https://dashboard.heroku.com/new?template=https://github.com/eymengunay/node-privus/tree/master
