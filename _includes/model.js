// Gimme a Github object! Please.
function github() {
  return new Github({
    token: $.cookie('oauth-token'),
    username: $.cookie('username'),
    auth: "oauth"
  });
}

var currentRepo = {
  user: null,
  repo: null,
  instance: null
};

// Smart caching (needed for managing subsequent updates)
// -------

function getRepo(user, repo) {
  if (currentRepo.user === user && currentRepo.repo === repo) {
    return currentRepo.instance; // Cached
  }

  currentRepo = {
    user: user,
    repo: repo,
    instance: github().getRepo(user, repo)
  };

  return currentRepo.instance;
}


// Authentication
// -------

function authenticate() {
  if ($.cookie("oauth-token")) return window.authenticated = true;
  var match = window.location.href.match(/\?code=([a-z0-9]*)/);

  // Handle Code
  if (match) {
    $.getJSON('{{site.gatekeeper_url}}/authenticate/'+match[1], function(data) {
      $.cookie('oauth-token', data.token);
      window.authenticated = true;
      // Adjust URL
      var regex = new RegExp("\\?code="+match[1]);
      window.location.href = window.location.href.replace(regex, '');
    });
    return false;
  } else {
    return true;  
  }
}


function logout() {
  window.authenticated = false;
  $.cookie("oauth-token", null);
}

// Load Application
// -------
// 
// Load everything that's needed for the app + header


function loadApplication(cb) {

  if (window.authenticated) {
    $.ajax({
      type: "GET",
      url: 'https://api.github.com/user',
      dataType: 'json',
      contentType: 'application/x-www-form-urlencoded',
      success: function(res) { 
        $.cookie("avatar", res.avatar_url);
        $.cookie("username", res.login);
        app.username = res.login;

        var user = github().getUser(app.username);
        var owners = {};

        user.repos(function(err, repos) {
          _.each(repos, function(r) {
            owners[r.owner.login] = owners[r.owner.login] ? owners[r.owner.login].concat([r])
                                                          : [r];
          });
          cb(null, { "available_repos": repos, "owners": owners });
        });
      },
      error: function(err) { 
        logout();
        cb(null, { "available_repos": [], "owners": {} });
      },
      headers : { Authorization : 'token ' + $.cookie('oauth-token') }
    });

  } else {
    cb(null, { "available_repos": [], "owners": {} });
  }
}

// Load Branches
// -------
// 
// List all available Jekyll branches

function loadBranches(user, repo, cb) {
  var repo = getRepo(user, repo);

  repo.listBranches(function(err, branches) {
    cb(null, branches);
  });
}

// Load Site
// -------
// 
// List all postings for a given site plus load _config.yml

function loadSite(user, repo, branch, path, cb) {
  var repo = getRepo(user, repo);
  function loadConfig(cb) {
    repo.read(branch, "_config.yml", function(err, data) {
      if (err) return cb(err);
      cb(null, jsyaml.load(data));
    });
  }


  loadConfig(function(err, config) {
    app.state.jekyll = !err;
    
    app.state.config = config;

    if (!path) path = config && config.prose && config.prose.rooturl ? config.prose.rooturl : "";

    repo.getSha(branch, path, function(err, sha) {
      repo.getTree(sha, function(err, tree) {
        if (err) return cb("Not found");

        var paths = _.compact(_.map(tree, function(file) {
          return file.type === "tree" ? (path ? path + "/" : "")+ file.path : null;
        }));

        paths = [path].concat(paths);

        // Include a parent folder path
        if (path !== "") paths = [_.parentPath(path)].concat(paths);

        app.state.config = config;
        app.state.paths = paths;
        app.state.path = path ? path : paths[0];

        var posts = _.map(tree, function(file) {
          // Make sense of the file path
          function semantify(file, filetype) {
            return {
              path: path == "" ? file.path : path + "/"+file.path,
              date: "",
              filetype: filetype,
              title: file.path
            };
          }

          if (file.type === "tree") return null; // Skip directories
          if (_.markdown(file.path)) return semantify(file, "markdown");
          if (!app.state.jekyll) return semantify(file, "file");
          return null;
        });
        
        cb(null, {"posts": _.compact(posts.reverse())});
      });
    });
  });
}


// Save File
// -------
// 
// List all postings for a given repository
// Looks into _posts/blog

function saveFile(user, repo, branch, path, file, metadata, content, message, cb) {

  var repo = getRepo(user, repo);
  function serialize() {
    if (app.state.jekyll && _.markdown(file)) {
      return ["---", metadata, "---"].join('\n')+'\n'+content;
    } else {
      return content;
    }
  }
  var path = path ? path+ "/"+ file : file;
  repo.write(branch, path, serialize(), message, cb);
}


// Delete Post
// -------

function deletePost(user, repo, branch, path, file, cb) {
  var repo = getRepo(user, repo);
  repo.remove(branch, path ? path+ "/" : "" + file, cb);
}


// Move Post
// -------

function movePost(user, repo, branch, path, newPath, cb) {
  var repo = getRepo(user, repo);
  repo.move(branch, path, newPath, cb);
}


// New Post
// -------
// 
// Prepare new empty post

function emptyPost(user, repo, branch, path, cb) {
  var rawMetadata = "layout: default\npublished: false";
  var metadata = {
    "layout": "default",
    "published": false,
  };

  var cfg = app.state.config
  if (cfg && cfg.prose && cfg.prose.metadata) {
    if (cfg.prose.metadata[path]) {
      metadata = cfg.prose.metadata[path];
      try {
        rawMetadata = YAML.encode(metadata);
      } catch(err) {
        console.log('ERROR encoding YAML');
        // No-op
      }
    }
  }

  cb(null, {
    "metadata": metadata,
    "raw_metadata": rawMetadata,
    "content": "# How does it work?\n\nEnter Text in Markdown format.",
    "repo": repo,
    "path": path,
    "persisted": false,
    "file": new Date().format("Y-m-d")+"-your-filename.md"
  });
}

// Load Post
// -------
// 
// List all postings for a given repository
// Looks into _posts/blog

function loadPost(user, repo, branch, path, file, cb) {
  var repo = getRepo(user, repo);

  repo.read(branch, path ? path + "/" + file : file, function(err, data) {
    if (err) return cb(err);
    function parse(content) {
      if (!app.state.jekyll) return {
        metadata: {},
        raw_metadata: "",
        content: content
      };

      var res = {};
      var chunked = (content+'\n').replace(/\r\n/g, "\n").split('---\n');
      if (chunked[0] === '' && chunked.length > 2) {
        res.metadata = jsyaml.load(chunked[1]);
        res.raw_metadata = chunked[1].trim();
        res.content = chunked.slice(2).join('---\n');
      } else {
        res.metadata = {};
        res.raw_metadata = "";
        res.content = content;
      }
      return res;
    }

    // Extract metadata
    var post = parse(data);
    cb(err, _.extend(post, {
      "markdown": _.markdown(file),
      "jekyll": _.jekyll(path, file),
      "repo": repo,
      "path": path,
      "file": file,
      "persisted": true
    }));
  });
}