/******************************************************************************/
/*
 *
 * Copyright 2012-2016 AOL Inc. All rights reserved.
 * 
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this Software except in compliance with the License.
 * You may obtain a copy of the License at
 * 
 *     http://www.apache.org/licenses/LICENSE-2.0
 * 
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
'use strict';

var https          = require('https')
  , wiseSource     = require('./wiseSource.js')
  , util           = require('util')
  ;

//////////////////////////////////////////////////////////////////////////////////
function OpenDNSSource (api, section) {
  OpenDNSSource.super_.call(this, api, section);
  this.waiting      = [];
  this.processing   = {};
  this.statuses     = {"-1": "malicious", "0":"unknown", "1":"benign"};
}
util.inherits(OpenDNSSource, wiseSource);

//////////////////////////////////////////////////////////////////////////////////
OpenDNSSource.prototype.getCategories = function () {
  var self = this;
  var options = {
      host: 'sgraph.api.opendns.com',
      port: '443',
      path: '/domains/categories/',
      method: 'GET',
      headers: {
          'Authorization': 'Bearer ' + self.key,
      }
  };

  var response = "";
  var request = https.request(options, function(res) {
    res.on('data', function (chunk) {
      response += chunk;
    });
    res.on('end', function () {
      self.categories = JSON.parse(response);
    });
  });
  request.on('error', function (err) {
    console.log(err);
  });

  request.end();
};
//////////////////////////////////////////////////////////////////////////////////
OpenDNSSource.prototype.performQuery = function () {
  var self = this;

  if (self.waiting.length === 0) {
    return;
  }

  if (self.api.debug > 0) {
    console.log("OpenDNS - Fetching %d", self.waiting.length);
  }


  // http://stackoverflow.com/questions/6158933/how-to-make-an-http-post-request-in-node-js/6158966
  // console.log("doing query:", waiting.length, "current cache", Object.keys(cache).length);
  var postData = JSON.stringify(self.waiting);
  self.waiting.length = 0;

  var postOptions = {
      host: 'sgraph.api.opendns.com',
      port: '443',
      path: '/domains/categorization/',
      method: 'POST',
      headers: {
          'Authorization': 'Bearer ' + self.key,
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': postData.length
      }
  };

  var response = "";
  var request = https.request(postOptions, function(res) {
    res.on('data', function (chunk) {
      response += chunk;
    });
    res.on('end', function (err) {
      var results;
      try {
        results = JSON.parse(response);
      } catch (e) {
        console.log("Error parsing for request:\n", postData, "\nresponse:\n", response);
        results = {};
      }
      for (var result in results) {
        var cbs = self.processing[result];
        if (!cbs) {
          return;
        }
        delete self.processing[result];

        var args = [self.statusField, self.statuses[results[result].status]];

        if (results[result].security_categories) {
          results[result].security_categories.forEach(function(value) {
            if (self.categories[value]) {
              args.push(self.scField, self.categories[value]);
            } else {
              console.log("Bad OpenDNS SC", value);
            }
          });
        }

        if (results[result].content_categories) {
          results[result].content_categories.forEach(function(value) {
            if (self.categories[value]) {
              args.push(self.ccField, self.categories[value]);
            } else {
              console.log("Bad OpenDNS CC", value, results);
            }
          });
        }

        result = {num: args.length/2, buffer: wiseSource.encode.apply(null, args)};

        var cb;
        while ((cb = cbs.shift())) {
          cb(null, result);
        }
      }
    });
  });
  request.on('error', function (err) {
    console.log(err);
  });

  // post the data
  request.write(postData);
  request.end();
};
//////////////////////////////////////////////////////////////////////////////////
OpenDNSSource.prototype.init = function() {
  this.key = this.api.getConfig("opendns", "key");
  if (this.key === undefined) {
    console.log("OpenDNS - No key defined");
    return;
  }

  this.api.addSource("opendns", this);
  this.getCategories();
  setInterval(this.getCategories.bind(this), 10*60*1000);
  setInterval(this.performQuery.bind(this), 500);

  this.statusField = this.api.addField("field:opendns.domain.status;db:opendns.dmstatus-term;kind:lotermfield;friendly:Status;help:OpenDNS domain security status;count:true");
  this.scField = this.api.addField("field:opendns.domain.security;db:opendns.dmscat-term;kind:termfield;friendly:Security;help:OpenDNS domain security category;count:true");
  this.ccField = this.api.addField("field:opendns.domain.content;db:opendns.dmccat-term;kind:termfield;friendly:Security;help:OpenDNS domain content category;count:true");

  this.api.addView("opendns", 
    "if (session.opendns)\n" +
    "  div.sessionDetailMeta.bold OpenDNS\n" +
    "  dl.sessionDetailMeta\n" +
    "    +arrayList(session.opendns, 'dmstatus-term', 'Status', 'opendns.domain.status')\n" +
    "    +arrayList(session.opendns, 'dmscat-term', 'Security Cat', 'opendns.domain.security')\n" +
    "    +arrayList(session.opendns, 'dmccat-term', 'Content Cat', 'opendns.domain.content')\n"
  );

  this.api.addRightClick("opendnsip", {name:"OpenDNS", url:"https://sgraph.opendns.com/ip-view/%TEXT%", category:"ip"});
  this.api.addRightClick("opendnsasn", {name:"OpenDNS", url:"https://sgraph.opendns.com/as-view/%REGEX%", category:"asn", regex:"^[Aa][Ss](\\d+)"});
  this.api.addRightClick("opendnshost", {name:"OpenDNS", url:"https://sgraph.opendns.com/domain-view/name/%HOST%/view", category:"host"});

};
//////////////////////////////////////////////////////////////////////////////////
OpenDNSSource.prototype.getDomain = function(domain, cb) {
  if (domain in this.processing) {
    this.processing[domain].push(cb);
    return;
  }

  this.processing[domain] = [cb];
  this.waiting.push(domain);
  if (this.waiting.length > 1000) {
    this.performQuery();
  }
};
//////////////////////////////////////////////////////////////////////////////////
exports.initSource = function(api) {
  var source = new OpenDNSSource(api, "opendns");
  source.init();
};
//////////////////////////////////////////////////////////////////////////////////
