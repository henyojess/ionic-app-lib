var fs = require('fs'),
    Q = require('q'),
    path = require('path'),
    colors = require('colors');
    // argv = require('optimist').argv,
    connect = require('connect'),
    finalhandler = require('finalhandler'),
    http = require('http'),
    serveStatic = require('serve-static'),
    tinylr = require('tiny-lr-fork'),
    lr = require('connect-livereload'),
    vfs = require('vinyl-fs'),
    request = require('request'),
    IonicProject = require('./project'),
    Task = require('./task').Task,
    proxyMiddleware = require('proxy-middleware'),
    url = require('url'),
    xml2js = require('xml2js'),
    IonicStats = require('./stats').IonicStats,
    Utils = require('./utils'),
    events = require('./events'),
    shelljs = require('shelljs'),
    ports = require('./ports');

var Serve = module.exports;

var lrServer,
    runningServer;

var DEFAULT_HTTP_PORT = 8100;
var DEFAULT_LIVE_RELOAD_PORT = 35729;
var IONIC_LAB_URL = '/ionic-lab';
var IONIC_ANGULAR_URL = '/angular.min.js';

Serve.listenForServerCommands = function listenForServerCommands(options) {
  // var self = this;
  var readline = require('readline');

  process.on("SIGINT", function(){
    process.exit();
  });

  var rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false
  });

  if(process.platform === "win32") {
    rl.on("SIGINT", function (){
      process.emit("SIGINT");
    });
  }

  rl.setPrompt('ionic $ ');
  rl.prompt();
  rl.on('line', function(entry) {
    if(entry === null) return;
    var input = (entry + '').trim();

    if (input === 'quit' || input === 'q') rl.close();

    if (input === null) return;
    input = (input + '').trim();

    if(input == 'restart' || input == 'r') {
      Serve._goToUrl('/?restart=' + Math.floor((Math.random() * 899999) + 100000), options);

    } else if(input.indexOf('goto ') === 0 || input.indexOf('g ') === 0) {
      var url = input.replace('goto ', '').replace('g ', '');
      Serve._goToUrl(url, options);

    } else if(input == 'consolelogs' || input == 'c') {
      options.printConsoleLogs = !options.printConsoleLogs;
      events.emit('log', 'Console log output: '.green + (options.printConsoleLogs ? 'enabled' : 'disabled'));
      if (options.printConsoleLogs) {
        events.removeAllListeners('consoleLog');
        events.on('consoleLog', console.log);
      } else {
        events.removeAllListeners('consoleLog');
      }
      Serve._goToUrl('/?restart=' + Math.floor((Math.random() * 899999) + 100000), options);

    } else if(input == 'serverlogs' || input == 's') {
      options.printServerLogs = !options.printServerLogs;
      events.emit('log', 'Server log output: '.green + (options.printServerLogs ? 'enabled' : 'disabled'));

    } else if(input.match(/^go\([+\-]?[0-9]{1,9}\)$/)) {
      Serve._goToHistory(input, options);

    } else if(input == 'help' || input == 'h') {
      Serve.printCommandTips();
    } else if(input == 'clear' || input == 'clr') {
      process.stdout.write("\u001b[2J\u001b[0;0H");

    } else {
      events.emit('log', '\nInvalid ionic server command'.error.bold);
      Serve.printCommandTips();
    }

    // events.emit('log', 'input: ', input);
    rl.prompt();
  }).on('close', function() {
    if (options.childProcess) {
      events.emit('log', 'Closing Gulp process'.yellow);
      options.childProcess.kill('SIGTERM');
    }
    process.exit(0);
  });

}

//isIonicServer = true when serving www directory, false when live reload
Serve.checkPorts = function(isIonicServer, testPort, testHost, options) {
  // events.emit('verbose', 'Serve.checkports isIonicServer', isIonicServer, 'testPort:', testPort, 'testHost', testHost, 'options:', options);
  var q = Q.defer();
  var message = [];

  if(isIonicServer) {
    testHost = (options.address == 'localhost') ? null : options.address;
  } else {
    testHost = null;
  }

  ports.getPort({port: testPort, host: testHost},
    function(err, port) {
    if(port != testPort) {
      message = ['The port ', testPort, ' was taken on the host ', options.address, ' - using port ', port, ' instead'].join('');
      events.emit('log', message.yellow.bold);
      if(isIonicServer) {
        options.port = port;
      } else {
        options.liveReloadPort = port;
      }
    }
    q.resolve();
  });

  return q.promise;
}

//argv should be parsed out and put into a nice hash before getting here.
Serve.loadSettings = function loadSettings(argv, project) {
  
  if (!argv) {
    var errorMessage = 'Serve.loadSettings - You must pass proper arguments to load settings from';
    events.emit('log', errorMessage);
    throw new Error(errorMessage);
  }
  if (!project) {
    var errorMessage = 'Serve.loadSettings - You must pass a project object to pull out project specific settings from';
    events.emit('log', errorMessage);
    throw new Error(errorMessage);
  }

  var options = {};

  options.port = options.port || argv.port || argv.p || DEFAULT_HTTP_PORT;
  options.liveReloadPort = options.liveReloadPort || argv.livereloadport || argv.r || argv['livereload-port'] || argv.i || DEFAULT_LIVE_RELOAD_PORT;
  options.launchBrowser = !argv.nobrowser && !argv.b;
  options.launchLab = options.launchBrowser && (argv.lab || argv.l);
  options.runLivereload = !(argv.nolivereload || argv.d);
  
  var noProxyFlag = argv.noproxy || argv.x || false;
  var proxies = project.get('proxies') || [];

  if (!noProxyFlag && proxies.length > 0) {
    options.useProxy = true;
    options.proxies = proxies;
  } else {
    options.useProxy = false;
    options.proxies = [];
  }

  options.watchSass = project.get('sass') === true && !argv.nosass && !argv.n;
  options.gulpStartupTasks = project.get('gulpStartupTasks');
  
  options.browser = argv.browser || argv.w || '';
  options.browserOption = argv.browserOption || argv.o || '';

  options.platform = argv.platform || argv.t || null;

  //Check for default browser being specified
  options.defaultBrowser = argv.defaultBrowser || argv.f || project.get('defaultBrowser');

  if(options.defaultBrowser) {
    project.set('defaultBrowser', options.defaultBrowser);
    project.save();
  }

  options.browser = options.browser || options.defaultBrowser;

  options.watchPatterns = project.get('watchPatterns') || ['www/**/*', '!www/lib/**/*'];
  options.printConsoleLogs = argv.consolelogs || argv['console-logs'] || argv.c;
  options.printServerLogs = argv.serverlogs || argv['server-logs'] || argv.s;
  options.isAddressCmd = argv._[0].toLowerCase() == 'address';
  options.documentRoot = project.get('documentRoot') || 'www';
  options.createDocumentRoot = project.get('createDocumentRoot') || null;
  options.contentSrc = path.join(options.documentRoot, Utils.getContentSrc(options.documentRoot));

  return options;
};


Serve.printCommandTips = function(ionic) {
  events.emit('log', 'Ionic server commands, enter:'.green.bold);
  events.emit('log', '  restart' + ' or '.green + 'r' + ' to restart the client app from the root'.green);
  events.emit('log', '  goto' + ' or '.green + 'g' + ' and a url to have the app navigate to the given url'.green);
  events.emit('log', '  consolelogs' + ' or '.green + 'c' + ' to enable/disable console log output'.green);
  events.emit('log', '  serverlogs' + ' or '.green + 's' + ' to enable/disable server log output'.green);
  events.emit('log', '  quit' + ' or '.green + 'q' + ' to shutdown the server and exit'.green);
  events.emit('log', '');
};

Serve.openBrowser = function openBrowser(options) {
  if(options.launchLab || options.launchBrowser) {
    var open = require('open');
    var openUrl = options.launchLab ? [Serve.host(options.address, options.port), IONIC_LAB_URL] : [Serve.host(options.address, options.port)];

    if(options.browserOption) {
      openUrl.push(options.browserOption)
    }

    if (options.platform) {
      openUrl.push('?ionicplatform=', options.platform);
    }

    try {
      open(openUrl.join(''), options.browser);
    } catch (ex) {
      events.emit('log', 'Error opening the browser - ', ex)
    }
  }
}

Serve.checkForDocumentRoot = function checkForDocumentRoot(options) {
  if (!fs.existsSync( path.resolve(options.documentRoot) )) {
    if (options.createDocumentRoot) {
      fs.mkdirSync(options.documentRoot);
    } else {
      return Utils.fail('"' + options.documentRoot + '" directory cannot be found. Please make sure the working directory is an Ionic project.');
    }
  }

  return true;
}

Serve.gulpStartupTasks = function gulpStartupTasks(options) {
  // gulpStartupTasks should be an array of tasks set in the project config
  // watchSass is for backwards compatible sass: true project config
  if ((options.gulpStartupTasks && options.gulpStartupTasks.length) || options.watchSass) {
    var tasks = options.gulpStartupTasks || ['sass','watch'];

    if(!Utils.gulpInstalledGlobally()) {
      var message = ['You have specified Gulp start up tasks in your ionic.project file.'.red, '\n', 'However, you do not have Gulp installed globally. Please run '.red, '`npm install -g gulp`'.green].join('');
      return ionic.fail(message)
    }

    events.emit('log', 'Gulp startup tasks:'.green.bold, tasks);
    return require('cross-spawn').spawn('gulp', tasks, { stdio: 'inherit' });
  }
}

Serve.runLivereload = function runLivereload(options, app) {
  var q = Q.defer();
  
  try {

    if (!options.runLivereload) {
      q.resolve();
      return q.promise;
    }

    //TODO - get file path with dir before it
    //EX They pass in /Users/joshbavari/Development/testing/facebooker
    options.watchPatterns.forEach(function(watchPath) {
      watchPath = path.join(options.appDirectory, watchPath);
    });

    vfs.watch(options.watchPatterns, {},function(f) {
      //TODO: Move prototype to Serve._changed
      Serve._changed(f.path, options);
    });

    options.liveReloadServer = Serve.host(options.address, options.liveReloadPort);

    lrServer = tinylr();

    lrServer.listen(options.liveReloadPort, function(err) {
      if (err) {
        q.reject(err);
        return Utils.fail('Unable to start live reload server:', err);
      } else {
        q.resolve(lrServer);
      }
    });

    app.use(require('connect-livereload')({
      port: options.liveReloadPort
    }));

  } catch (ex) {
    q.reject(ex);
    Utils.fail('Live Reload failed to start, error: ', ex.message);
  }

  return q.promise;
};

Serve.setupProxy = function setupProxy(options, app) {
  if(options.useProxy) {

    for (var x=0; x < options.proxies.length; x++) {
      var proxy = options.proxies[x];

      var opts = url.parse(proxy.proxyUrl);
      if (proxy.proxyNoAgent)
          opts.agent = false;

      opts.rejectUnauthorized = !(proxy.rejectUnauthorized === false);

      app.use(proxy.path, proxyMiddleware(opts));
      events.emit('log', 'Proxy added:'.green.bold, proxy.path + " => " + url.format(proxy.proxyUrl));
    }
  }
};

Serve.startServer = function startServer(options, app) {
  options.devServer = Serve.host(options.address, options.port);
  events.emit('verbose', 'Starting server at host address - ' + options.devServer);
  var rootDirectory = path.join(options.appDirectory, options.documentRoot);
  // Serve up the www folder by default

  if (options.printConsoleLogs) {
    events.on('consoleLog', console.log);
  } else {
    events.removeAllListeners('consolelog');
  }

  var serve = serveStatic(rootDirectory);

  // Create static server
  var server = http.createServer(function(req, res){
    var done = finalhandler(req, res);

    var urlParsed = url.parse(req.url, true);
    var platformOverride = urlParsed.query && urlParsed.query.ionicplatform;

    var platformUrl = getPlatformUrl(req);
    if(platformUrl) {
      var platformWWW = path.join(options.appDirectory, getPlatformWWW(req));
      // var platformWWW = path.join(options.appDirectory, platformWWW);

      // platformWWW = appPlatformWWW;

      if (options.isPlatformServe) {
        fs.readFile( path.resolve(path.join(platformWWW, platformUrl)), function (err, buf) {
          res.setHeader('Content-Type', 'application/javascript');
          if (err) {
            res.end('// mocked cordova.js response to prevent 404 errors during development');
            if(req.url == '/cordova.js') {
              Serve.serverLog(req, '(mocked)', options);
            } else {
              Serve.serverLog(req, '(Error ' + platformWWW + ')', options);
            }
          } else {
            Serve.serverLog(req, '(' + platformWWW + ')', options);
            res.end(buf);
          }
        });
      } else {
        Serve.serverLog(req, '(mocked)', options);
        res.setHeader('Content-Type', 'application/javascript');
        res.end('// mocked cordova.js response to prevent 404 errors during development');
      }
      return;
    }

    if(options.printConsoleLogs && req.url === '/__ionic-cli/console') {
      Serve.consoleLog(req);
      res.end('');
      return;
    }

    if(req.url === IONIC_LAB_URL) {
      // Serve the lab page with the given object with template data
      var labServeFn = function(context) {
        fs.readFile(path.resolve(path.join(__dirname, 'assets/preview.html')), function(err, buf) {
          var html;
          if(err) {
            res.end('404');
          } else {
            html = buf.toString('utf8');
            html = html.replace('//INSERT_JSON_HERE', 'var BOOTSTRAP = ' + JSON.stringify(context || {}));
          }
          res.setHeader('Content-Type', 'text/html');
          res.end(html);
        });
      };

      // If the config.xml file exists, let's parse it for some nice features like
      // showing the name of the app in the title
      if(fs.existsSync('config.xml')) {
        fs.readFile(path.resolve('config.xml'), function(err, buf) {
          var xml = buf.toString('utf8');
          xml2js.parseString(xml, function (err, result) {
            labServeFn({
              appName: result.widget.name[0]
            });
          });
        });
      } else {
        labServeFn();
      }

      return;
    }

    if (req.url == IONIC_ANGULAR_URL) {
      fs.readFile(path.resolve(path.join(__dirname, 'assets/angular.min.js')), function(err, buf) {
        if(err) {
          res.end('404');
        } 
        var jsFile = buf.toString('utf8');
        res.setHeader('Content-Type', 'application/javascript');
        res.end(jsFile);
      });
      return;
    }

    if(req.url.split('?')[0] === '/') {
      var contentPath = path.join(options.appDirectory, options.contentSrc);
      fs.readFile( contentPath, 'utf8', function (err, buf) {
        res.setHeader('Content-Type', 'text/html');
        if (err) {
          Serve.serverLog(req, 'ERROR!', options);
          res.end(err.toString());
        } else {
          Serve.serverLog(req, '(' + options.contentSrc + ')', options);

          var html = injectGoToScript( buf.toString('utf8') );

          if(options.printConsoleLogs) {
            html = injectConsoleLogScript(html);
          }

          if(platformOverride) {
            html = injectPlatformScript( html, platformOverride );
          }

          res.end(html);
        }
      });
      return;
    }

    // root www directory file
    Serve.serverLog(req, null, options);
    serve(req, res, done);
  });


  // Listen
  app.use(server);
  try {
    runningServer = app.listen(options.port, options.address);
  }catch(ex) {
    Utils.fail('Failed to start the Ionic server: ', ex.message);
  }

  events.emit('log', ['Running dev server:'.green.bold, options.devServer].join(' '));
};

Serve.start = function start(options) {

  if (!options) {
    throw 'You cannot serve without options.';
  }

  try {
    var app = connect();
    options.childProcess = null;

    if (!Serve.checkForDocumentRoot(options)) {
      return Q(); //It failed, do nothing
    }

    if (!options.nogulp) {
    //Gulp serve start tasks
      options.childProcess = Serve.gulpStartupTasks(options);
    }

    var runliveReloadProcess = Serve.runLivereload(options, app);

    return runliveReloadProcess
    .then(function(server) {
      events.emit('log', 'Running live reload server:'.green.bold, options.liveReloadServer );
      events.emit('log', 'Watching :'.green.bold, options.watchPatterns);
      if (options.useProxy) {
        return Serve.setupProxy(options, app);
      }
    })
    .then(function(data) {
      return Serve.startServer(options, app);
    })
    .then(function() {
      if (options.launchBrowser) {
        Serve.openBrowser(options);
      }
    })
    .catch(function(error) {
      events.emit('log', 'Ionic serve failed - error:', error);
    });
  } catch(e) {
    var msg;
    if(e && (e + '').indexOf('EMFILE') > -1) {
      msg = (e + '\n').error.bold +
            'The watch process has exceed the default number of files to keep open.\n'.error.bold +
            'You can change the default with the following command:\n\n'.error.bold +
            '  ulimit -n 1000\n\n' +
            'In the command above, it\'s setting the default to watch a max of 1000 files.\n\n'.error.bold;

    } else {
      msg = ('server start error: ' + e.stack).error.bold;
    }
    events.emit('log', msg);
    process.exit(1);
  }
};

Serve.showFinishedServeMessage = function showFinishedServeMessage(options) {
  Serve.printCommandTips(options);
  Serve.listenForServerCommands(options);
};

Serve.serverLog = function(req, msg, options) {
  if (options.printServerLogs) {
    var log = 'serve  '.yellow;

    log += (req.url.length > 60 ? req.url.substr(0, 57) + '...' : req.url).yellow;

    if(msg) {
      log += '  ' + msg.yellow;
    }

    var ua = (req.headers && req.headers['user-agent'] || '');
    if(ua.indexOf('Android') > 0) {
      log += '  Android'.small;
    } else if(ua.indexOf('iPhone') > -1 || ua.indexOf('iPad') > -1 || ua.indexOf('iPod') > -1) {
      log += '  iOS'.small;
    } else if(ua.indexOf('Windows Phone') > -1) {
      log += '  Windows Phone'.small;
    }

    events.emit('serverlog', log);
  }
};


Serve.consoleLog = function(req) {
  var body = '';

  req.on('data', function (data) {
    if(data) body += data;
  });

  req.on('end', function () {
    if(!body) return;

    try {
      var log = JSON.parse(body);

      var msg = log.index + '  ';
      while(msg.length < 5) {
        msg += ' ';
      }

      msg += ' ' + (log.ts + '').substr(7) + '   ';

      msg += log.method;
      while(msg.length < 24) {
        msg += ' ';
      }

      var msgIndent = '';
      while(msgIndent.length < msg.length) {
        msgIndent += ' ';
      }

      if(log.method == 'dir' || log.method == 'table') {
        var isFirstLine = true;

        log.args.forEach(function(argObj){

          for(objKey in argObj) {
            if(isFirstLine) {
              isFirstLine = false;
            } else {
              msg += '\n' + msgIndent;
            }
            msg += objKey + ': ';
            try {
              msg += ( JSON.stringify(argObj[objKey], null, 1) ).replace(/\n/g, '');
            } catch(e) {
              msg += argObj[objKey];
            }
          }

        });

      } else if(log.args.length) {
        if(log.args.length === 2 && log.args[0] === '%o' && log.args[1] == '[object Object]') return;
        msg += log.args.join(', ');
      }

      if(log.method == 'error' || log.method == 'exception') msg = msg.red;
      else if(log.method == 'warn') msg = msg.yellow;
      else if(log.method == 'info') msg = msg.green;
      else if(log.method == 'debug') msg = msg.blue;

      events.emit('consoleLog', msg);
    }catch(e){}
  });
};


function getPlatformUrl(req) {
  if(req.url == '/cordova.js' || req.url == '/cordova_plugins.js' || req.url.indexOf('/plugins/') === 0) {
    return req.url;
  }
}


function getPlatformWWW(req) {
  var platformPath = 'www';

  if(req && req.headers && req.headers['user-agent']) {
    var ua = req.headers['user-agent'].toLowerCase();
    if(ua.indexOf('iphone') > -1 || ua.indexOf('ipad') > -1 || ua.indexOf('ipod') > -1) {
      platformPath = path.join('platforms', 'ios', 'www');

    } else if(ua.indexOf('android') > -1) {
      platformPath = path.join('platforms', 'android', 'assets', 'www');
    }
  }

  return platformPath;
}


function injectConsoleLogScript(html) {
  try{
    var findTags = html.match(/<html(?=[\s>])(.*?)>|<head>|<meta charset(.*?)>/gi);
    var insertAfter = findTags[ findTags.length - 1 ];

    return html.replace(insertAfter, insertAfter + '\n\
    <script>\n\
      // Injected Ionic CLI Console Logger\n\
      (function() {\n\
        var methods = "assert clear count debug dir dirxml error exception group groupCollapsed groupEnd info log markTimeline profile profileEnd table time timeEnd timeStamp trace warn".split(" ");\n\
        var console = (window.console=window.console || {});\n\
        var logCount = 0;\n\
        window.onerror = function(msg, url, line) {\n\
          if(msg && url) console.error(msg, url, (line ? "Line: " + line : ""));\n\
        };\n\
        function sendConsoleLog(method, args) {\n\
          try {\n\
            var xhr = new XMLHttpRequest();\n\
            xhr.open("POST", "/__ionic-cli/console", true);\n\
            xhr.send(JSON.stringify({ index: logCount, method: method, ts: Date.now(), args: args }));\n\
            logCount++;\n\
          } catch(e){}\n\
        }\n\
        for(var x=0; x<methods.length; x++) {\n\
          (function(m){\n\
            var orgConsole = console[m];\n\
            console[m] = function() {\n\
              try {\n\
                sendConsoleLog(m, Array.prototype.slice.call(arguments));\n\
                if(orgConsole) orgConsole.apply(console, arguments);\n\
              } catch(e){}\n\
            };\n\
          })(methods[x]);\n\
        }\n\
      }());\n\
    </script>');
  }catch(e){}

  return html;
}


function injectGoToScript(html) {
  try{
    var findTags = html.match(/<html(?=[\s>])(.*?)>|<head>|<meta charset(.*?)>/gi);
    var insertAfter = findTags[ findTags.length - 1 ];

    return html.replace(insertAfter, insertAfter + '\n\
    <script>\n\
      // Injected Ionic Go To URL Live Reload Plugin\n\
      window.LiveReloadPlugin_IonicGoToUrl = (function() {\n\
        var GOTO_KEY = "__ionic_goto_url__";\n\
        var HISTORY_GO_KEY = "__ionic_history_go__";\n\
        var GoToUrlPlugin = function(window, host) {\n\
          this.window = window;\n\
          this.host = host;\n\
        }\n\
        GoToUrlPlugin.identifier = "__ionic_goto_url__";\n\
        GoToUrlPlugin.version = "1.0";\n\
        GoToUrlPlugin.prototype.reload = function(path) {\n\
          try {\n\
            if(path) {\n\
              if(path.indexOf(GOTO_KEY) === 0) {\n\
                this.window.document.location = path.replace(GOTO_KEY, "");\n\
                return true;\n\
              }\n\
              if(path.indexOf(HISTORY_GO_KEY) === 0) {\n\
                this.window.document.history.go( parseInt(path.replace(HISTORY_GO_KEY, ""), 10));\n\
                return true;\n\
              }\n\
            }\n\
          } catch(e) {\n\
            console.log(e);\n\
          }\n\
          return false;\n\
        };\n\
        return GoToUrlPlugin;\n\
      })();\n\
    </script>');
  }catch(e){}

  return html;
}

/**
 * Inject the platform override for choosing Android or iOS during
 * development.
 */
function injectPlatformScript(html, platformOverride) {
  try {
    var findTags = html.toLowerCase().indexOf('</body>');
    if(findTags < 0) { return html; }

    return html.slice(0, findTags) + '\n' +
    '<script>\n' +
      'ionic && ionic.Platform && ionic.Platform.setPlatform("' + platformOverride + '");\n' +
    '</script>\n' +
    html.slice(findTags);
  } catch(e) {}

  return html;
}

Serve._changed = function(filePath, options) {
  // Cleanup the path a bit
  // var pwd = process.cwd();
  var pwd = path.join(options.appDirectory);
  filePath = filePath.replace(pwd + '/', '');

  if( filePath.indexOf('.css') > 0 ) {
    events.emit('log', ('CSS changed:  ' + filePath).green );
  } else if( filePath.indexOf('.js') > 0 ) {
    events.emit('log', ('JS changed:   ' + filePath).green );
  } else if( filePath.indexOf('.html') > 0 ) {
    events.emit('log', ('HTML changed: ' + filePath).green );
  } else {
    events.emit('log', ('File changed: ' + filePath).green );
  }

  Serve._postToLiveReload( [filePath], options );
};


Serve._goToUrl = function(url, options) {
  events.emit('log', ('Loading: ' + url).green );
  Serve._postToLiveReload( ['__ionic_goto_url__' + url], options );
};


Serve._goToHistory = function(goHistory, options) {
  goHistory = goHistory.replace('go(', '').replace(')', '');
  events.emit('log', ('History Go: ' + goHistory).green );
  Serve._postToLiveReload( ['__ionic_history_go__' + goHistory], options );
};


Serve._postToLiveReload = function(files, options) {
  var postUrl = [options.liveReloadServer, '/changed'].join('')
  request.post(postUrl, {
    path: '/changed',
    method: 'POST',
    body: JSON.stringify({
      files: files
    })
  }, function(err, res, body) {
    if(err) {
      events.emit('log','Unable to update live reload:', err);
    }
  });

}


Serve.getAddress = function(options) {
  var q = Q.defer();
  try {
    var addresses = [];
    var os = require('os');
    var ifaces = os.networkInterfaces();
    var ionicConfig = require('./config').load();

    var addressConfigKey = (options.isPlatformServe ? 'platformServeAddress' : 'ionicServeAddress');
    var tryAddress;

    if(options.isAddressCmd) {
      // reset any address configs
      ionicConfig.set('ionicServeAddress', null);
      ionicConfig.set('platformServeAddress', null);
    } else {
      if(!options.address)
        tryAddress = ionicConfig.get(addressConfigKey);
      else
        tryAddress = options.address;
    }

    if(ifaces){
      for (var dev in ifaces) {
        if(!dev) continue;
        ifaces[dev].forEach(function(details){
          if (details && details.family == 'IPv4' && !details.internal && details.address) {
            addresses.push({
              address: details.address,
              dev: dev
            });
          }
        });
      }
    }

    if(tryAddress) {
      if(tryAddress == 'localhost') {
        options.address = tryAddress;

        q.resolve();
        return q.promise;
      }
      for(var x=0; x<addresses.length; x++) {
        // double check if this address is still available
        if(addresses[x].address == tryAddress)
        {
          options.address = addresses[x].address;

          q.resolve();
          return q.promise;
        }
      }
      if (options.address) {
        Utils.fail('Address ' + options.address + ' not available.');
        return q.promise;
      }
    }

    if (addresses.length > 0) {
      
      if (!options.isPlatformServe) {
        addresses.push({
          address: 'localhost'
        });
      }

      if (addresses.length === 1) {
        options.address = addresses[0].address;
        q.resolve();
        return q.promise;
      } 

      events.emit('log', '\nMultiple addresses available.'.error.bold);
      events.emit('log', 'Please select which address to use by entering its number from the list below:'.error.bold);
      if (options.isPlatformServe) {
        events.emit('log', 'Note that the emulator/device must be able to access the given IP address'.small);
      }

      for (var x=0; x < addresses.length; x++) {
        events.emit('log',  (' ' + (x+1) + ') ' + addresses[x].address + ( addresses[x].dev ? ' (' + addresses[x].dev + ')' : '' )).yellow );
      }

      var prompt = require('prompt');
      var promptProperties = {
        selection: {
          name: 'selection',
          description: 'Address Selection: '.yellow.bold,
          required: true
        }
      };

      // prompt.override = argv;
      prompt.message = '';
      prompt.delimiter = '';
      prompt.start();

      prompt.get({properties: promptProperties}, function (err, promptResult) {
        if(err && err.message !== 'canceled') {
          events.emit('verbose', 'User prompted to select address - an error occured', err);
          q.reject(err);
          return events.emit('log', err);
        }
        // } else {
        //   return q.resolve(false);
        // }

        var selection = promptResult.selection;
        for(var x=0; x<addresses.length; x++) {
          if(selection == (x + 1) || selection == addresses[x].address || selection == addresses[x].dev) {
            options.address = addresses[x].address;
            if(!options.isAddressCmd) {
              events.emit('log', 'Selected address: '.green.bold + options.address);
            }
            ionicConfig.set(addressConfigKey, options.address);
            prompt.resume();
            q.resolve();
            return q.promise;
          }
        }

        Utils.fail('Invalid address selection');
      });

    } else if (options.isPlatformServe) {
      // no addresses found
      Utils.fail('Unable to find an IPv4 address for run/emulate live reload.\nIs WiFi disabled or LAN disconnected?');

    } else {
      // no address found, but doesn't matter if it doesn't need an ip address and localhost will do
      options.address = 'localhost';
      q.resolve();
    }

  } catch(e) {
    Utils.fail('Error getting IPv4 address: ' + e);
  }

  return q.promise;
};

Serve.host = function host(address, port) {
  if (require('os').platform().indexOf('win') != -1 && (address == '0.0.0.0' || address.indexOf('0.0.0.0') != -1) ) {
    //Windows doesnt understand 0.0.0.0 - direct to localhost instead
    address = 'localhost';
  }
  var hostAddress = ['http://', address, ':', port].join('');
  return hostAddress;
};


Serve.stopServer = function stopServer() {
  if (runningServer) {
    runningServer.close();
    lrServer.close();
    events.emit('log', 'Server closed');
  } else {
    events.emit('log', 'Server not running');
  }
}
