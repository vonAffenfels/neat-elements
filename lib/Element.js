"use strict";

var Application = require('neat-base').Application;
var mongoose = require("mongoose");
var Promise = require("bluebird");

module.exports = class Element {

    constructor(id) {
        this.id = id;
        this.config = null;
        this.log = Application.getLogger(id);
        this.req = null;
    }

    setConfig(config) {
        this.config = config;
    }

    setRequest(req) {
        this.req = req;
        this.res = req.res;
    }

}
