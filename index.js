"use strict";

var Application = require("neat-base").Application;
var Module = require("neat-base").Module;
var Tools = require("neat-base").Tools;
var Element = require('./lib/Element.js');
var fs = require("fs");
var merge = require("merge");
var Promise = require("bluebird");

module.exports = class Elements extends Module {

    static defaultConfig() {
        return {
            elementRoot: "elements",
            cacheModuleName: "cache",
            esiEnabled: false,
            showMissingElementWarnings: true,
            showDispatchingDebug: true,
            slotOrder: [
                "html_head",
                "header",
                "content",
                "footer",
                "html_footer"
            ]
        }
    }

    init() {
        return new Promise((resolve, reject) => {
            this.log.debug("Initializing...");

            this.elements = {};
            this.Element = Element;
            this.knownMissingElements = [];

            return this.loadElements().then(resolve, reject);
        });
    }

    getDataForElement(elementId, req, configOverwrite) {
        return new Promise((resolve, reject) => {
            return this.dispatchElement({
                element: elementId,
                configOverwrite: configOverwrite
            }, req).then((data) => {
                return resolve(data);
            }, (err) => {
                this.log.error(err);
                return reject(err);
            });
        });
    }

    getElementById(id) {
        if (!this.elements || !id) {
            return null;
        }

        id = this.fixElementId(id);

        return this.elements[id] || null;
    }

    fixElementId(id) {
        if (!id) {
            return id;
        }

        var idParts = id.split(".");

        if (idParts.length > 2) {
            id = idParts.shift() + "." + idParts.shift() + (idParts.map((part) => {
                    return Tools.capitalizeFirstLetter(part);
                }).join())
        }

        return id;
    }

    loadElements() {
        return new Promise((resolve, reject) => {
            this.log.debug("Load elements...");
            var rootDir = Application.config.config_path + "/elements";

            if (!fs.existsSync(rootDir)) {
                fs.mkdirSync(rootDir);
            }

            var loadElementFuncs = [];
            var elementFiles = fs.readdirSync(rootDir);

            for (var i = 0; i < elementFiles.length; i++) {
                var elementFile = elementFiles[i];
                if (!elementFile.match(/(.*)\.json$/)) {
                    continue;
                }
                var categoryIdPart = elementFile.replace(/(.*?)\.json$/, "$1");
                var fileContent = Tools.loadCommentedConfigFile(rootDir + "/" + elementFile);

                for (var j = 0; j < fileContent.length; j++) {
                    var elementConfig = fileContent[j];
                    var elementId = categoryIdPart + "." + elementConfig.name;

                    ((elementId, elementConfig) => {
                        loadElementFuncs.push(new Promise((resolve, reject) => {
                            this.loadElement(categoryIdPart, elementConfig).then((elementClass) => {
                                this.elements[elementId] = {
                                    config: elementConfig,
                                    esi: elementConfig.esi,
                                    action: elementConfig.action,
                                    elementClass: elementClass
                                };

                                resolve();
                            }, reject);
                        }));
                    })(elementId, elementConfig)
                }
            }

            Promise.all(loadElementFuncs).then(resolve, reject);
        });
    }

    loadElement(category, elementConfig) {
        var rootDir = Application.config.root_path + "/" + this.config.elementRoot;

        if (!fs.existsSync(rootDir)) {
            fs.mkdirSync(rootDir);
        }

        return new Promise((resolve, reject) => {

            var path = category + "/" + elementConfig.file;

            try {
                var elementClass = require(rootDir + "/" + path + ".js");
            } catch (e) {
                return reject(e);
            }

            resolve(elementClass);
        });
    }

    dispatchElementsInSlots(slots, req) {
        slots = JSON.parse(JSON.stringify(slots));

        return new Promise((resolve, reject) => {
            if (this.config.showDispatchingDebug) {
                this.log.debug("Dispatching elements for slots");
            }

            var elementParalellFuncs = [];
            for (var i = 0; i < this.config.slotOrder.length; i++) {
                var slotName = this.config.slotOrder[i];
                if (!slots[slotName]) {
                    continue;
                }

                for (var j = 0; j < slots[slotName].length; j++) {
                    var element = slots[slotName][j];
                    elementParalellFuncs.push(this.dispatchElement({
                        element: element
                    }, req, slotName, j));
                }
            }

            Promise.all(elementParalellFuncs).then((data) => {

                for (var j = 0; j < data.length; j++) {
                    var element = data[j];

                    for (var slotName in slots) {
                        for (var k = 0; k < slots[slotName].length; k++) {
                            if (element.slotName == slotName && element.position == k) {
                                slots[slotName][k] = element;
                            }
                        }
                    }
                }

                for (var key in slots) {
                    slots[key] = slots[key].filter(v => !!v);
                }

                resolve(slots);
            }, (err) => {
                reject(err);
            });
        });
    }

    dispatchElement(elementConfig, req, slotName, position) {
        return new Promise((resolve, reject) => {
            var element = this.getElementById(elementConfig.element);
            if (element && element.config && elementConfig.configOverwrite) {
                element.config.config = merge.recursive(element.config.config || {}, elementConfig.configOverwrite);
            }

            var returnVal = {
                slotName: slotName,
                position: position,
                page: req.path
            };

            if (!element) {
                if (this.config.showMissingElementWarnings) {
                    if (this.knownMissingElements.indexOf(elementConfig.element) === -1) {
                        this.log.warn("Element " + elementConfig.element + " not found");
                        this.knownMissingElements.push(elementConfig.element);
                    }
                }
                returnVal.doesNotExist = true;
                returnVal.element = elementConfig.element;
                return resolve(returnVal);
            }

            if (element.config.cache !== false) {
                if (!element.config.cache && Application.modules[this.config.cacheModuleName]) {
                    element.config.cache = Application.modules[this.config.cacheModuleName].config.caches.elementDefault;
                }
            }

            var cacheKeyObj = {
                element: elementConfig,
                esi: element.esi || false,
                reqIsEsi: req.esi,
                query: req.query,
                body: req.body,
                page: req.path
            };

            if (element.config.cache && element.config.cache.page === false) {
                delete cacheKeyObj.page;
            }

            if (Application.modules[this.config.cacheModuleName]) {
                var cachekey = Application.modules[this.config.cacheModuleName].getKeyFromObject(cacheKeyObj);
            } else {
                var cachekey = "nocache!";
            }

            var cachePromise = Promise.resolve();

            if (element.config.cache !== false && Application.modules[this.config.cacheModuleName]) {
                cachePromise = Application.modules[this.config.cacheModuleName].get(cachekey);
            }

            return cachePromise.then((cachedData) => {
                if (req && req.clearCache) {
                    cachedData = null;
                }

                if (cachedData) {
                    elementConfig.cached = true;
                    if (cachedData.meta) {
                        if (cachedData.meta.data) {
                            req.meta.data = req.meta.data.concat(cachedData.meta.data);
                        }
                    }

                    cachedData.fromCache = true;
                    if (this.config.showDispatchingDebug) {
                        this.log.debug("Dispatching element " + elementConfig.element + " in slot " + slotName + " from CACHE");
                    }

                    return resolve(cachedData);
                }

                if (this.config.showDispatchingDebug) {
                    this.log.debug("Dispatching element " + elementConfig.element + " in slot " + slotName);
                }

                elementConfig.cached = false;

                try {
                    var elementInstance = new element.elementClass(this.fixElementId(elementConfig.element));

                    elementInstance.setConfig(element.config.config || {});
                    elementInstance.setRequest(req);

                    returnVal.config = element.config.config || {};
                    returnVal.element = elementConfig.element;
                    returnVal.statusCodeIfError = element.config.statusCodeIfError;
                    returnVal.esi = element.esi || false;
                    returnVal.id = elementConfig.element.split(".").shift();

                    if (element.config.action && element.config.action != element.config.file) {
                        returnVal.id += "." + element.config.file + Tools.capitalizeFirstLetter(element.config.action);
                    } else {
                        returnVal.id += "." + element.config.file;
                    }

                    var action = "execute";

                    if (element.action) {
                        action = action + Tools.capitalizeFirstLetter(element.action);
                    } else {
                        var actionPart = elementConfig.element.split(".").pop();
                        action = action + Tools.capitalizeFirstLetter(actionPart);
                    }

                    if (!elementInstance[action]) {
                        this.log.error("Action " + action + " is missing for " + elementConfig.element);
                        returnVal.actionMissing = true;
                        return resolve(returnVal);
                    }

                    var tooLong = null;

                    return new Promise((resolve, reject) => {
                        returnVal.startTime = new Date();
                        const timeout = element.config.timeout || 5000;

                        tooLong = setTimeout(() => {
                            this.log.warn("Element " + elementConfig.element + " took more than " + timeout / 1000 + " seconds!", req.path);
                            var tooLongError = new Error("Element " + elementConfig.element + " took more than " + timeout / 1000 + " seconds!");
                            tooLongError.tooLong = true;
                            reject(tooLongError);
                        }, timeout);

                        try {
                            if (element.esi && !req.esi && req.method === "GET" && this.config.esiEnabled) {
                                return resolve();
                            } else {
                                return elementInstance[action](resolve, reject);
                            }
                        } catch (err) {
                            clearTimeout(tooLong);
                            if (err instanceof Error) {
                                returnVal.stack = err.stack;
                            }

                            this.log.error("Error in Element: (" + req.url + ") " + returnVal.element);
                            this.log.error(err);

                            returnVal.isFatal = true;
                            reject(err);
                        }

                    }).then((elementResult) => {
                        clearTimeout(tooLong);
                        returnVal.endTime = new Date();
                        returnVal.cached = elementConfig.cached;
                        returnVal.duration = returnVal.endTime.getTime() - returnVal.startTime.getTime();
                        if (this.config.showDispatchingDebug) {
                            this.log.debug("Dispatched element " + elementConfig.element + " in " + returnVal.duration + "ms");
                        }
                        delete returnVal.startTime;
                        delete returnVal.endTime;

                        for (var key in elementResult) {
                            returnVal[key] = elementResult[key];
                        }

                        returnVal.cache = element.config.cache;

                        if ((elementResult && elementResult.NO_CACHE) || req.isPreview) {
                            returnVal.cache = false;
                            element.config.cache = false;
                        }

                        if (returnVal.meta) {
                            if (returnVal.meta.data) {
                                req.meta.data = req.meta.data.concat(returnVal.meta.data);
                            }
                        }

                        if (element.config && element.config.cache && Application.modules[this.config.cacheModuleName]) {
                            return Application.modules[this.config.cacheModuleName].set(cachekey, returnVal, element.config.cache).then(resolve);
                        } else {
                            return resolve(returnVal);
                        }
                    }, (err) => {
                        this.log.error("Error in Element: (" + req.url + ") " + returnVal.element);
                        this.log.error(err);

                        returnVal.isError = true;

                        if (err.stack) {
                            if (!err.tooLong) {
                                this.log.error(err);
                                this.log.error(err.stack);
                                returnVal.stack = err.stack;
                            }
                            err = err.toString();
                        }


                        clearTimeout(tooLong);
                        returnVal.error = err;
                        resolve(returnVal);
                    })

                } catch (err) {
                    returnVal.isError = true;

                    if (err.stack) {
                        returnVal.stack = err.stack;
                        err = err.toString();
                    }

                    returnVal.error = err;
                    resolve(returnVal);
                }

            });
        });
    }
}

module.exports.Element = Element;
