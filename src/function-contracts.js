// -*- js-indent-level: 2 -*-
"use strict";

/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/*jshint eqeqeq:true, bitwise:true, forin:true, immed:true, latedef:true, newcap:true, undef:true, strict:false, node:true, loopfunc:true, latedef:false */

var util = require('util');
var _ = require('underscore');
var u = require('./utils');
var c = require('./contract.impl');
var errors = require('./errors');

function checkOptionalArgumentFormals(who, argumentContracts) {
  var optionsOnly = false;
  _.each(argumentContracts, function (c, i) {
    if (optionsOnly && !c.isOptional) {
      throw new errors.ContractLibraryError('fun', false, "The non-optional "+i+"th arguments cannot follow an optional arguments.");
    }

    optionsOnly = optionsOnly || c.isOptional;
  });
}

function checkOptionalArgumentCount(argumentContracts, extraArgumentContract, actuals, context) {
  var nOptional = _.size(_.filter(argumentContracts, function (c) { return c.isOptional; }));
  var nRequired = _.size(argumentContracts) - nOptional;

  if (nOptional === 0 && !extraArgumentContract) {

    if (actuals.length !== nRequired) {
      context.fail(new errors.ContractError
                   (context, "Wrong number of arguments, expected " + nRequired + " but got " + actuals.length)
                   .fullContract());
    }

  } else if (actuals.length < nRequired) {
    context.fail(new errors.ContractError
                 (context, "Too few arguments, expected at least " + nRequired + " but got " + actuals.length)
                 .fullContract());

  } else if (!extraArgumentContract &&
             actuals.length > nRequired + nOptional) {
    context.fail(new errors.ContractError
                 (context, "Too many arguments, expected at most " + (nRequired + nOptional) + " but got " + actuals.length)
                 .fullContract());
  }
}

function fnHelper(who, argumentContracts) {
  var self = new c.privates.Contract(who);
  self.argumentContracts = argumentContracts;
  checkOptionalArgumentFormals(who, self.argumentContracts);

  self.isFunctionContract = true;
  self.extraArgumentContract = false;
  self.thisContract = c.any;
  self.resultContract = c.any;
  self.firstChecker = _.isFunction;
  self.wrapper = function (fn, next, context) {
    var self = this;

    if (!context.thingName) {
      context.thingName = u.functionName(fn);
    }

    var r = function (/* ... */) {
      var contextHere = u.clone(context);
      contextHere.stack = u.clone(context.stack);
      contextHere.thingName = self.thingName || contextHere.thingName;
      var reverseBlame = function(r) { if (r) contextHere.blameMe = !contextHere.blameMe; };

      reverseBlame(true);
      checkOptionalArgumentCount(self.argumentContracts, self.extraArgumentContract, arguments, contextHere);
      reverseBlame(true);
      var next = function(nextContract, nextV, nextContext, rb) {
        contextHere.stack.push(nextContext);
        reverseBlame(rb);
        var result = c.privates.checkWrapWContext(nextContract, nextV, contextHere);
        reverseBlame(rb);
        contextHere.stack.pop();
        return result;
      };

      var wrappedThis = next(self.thisContract, this, errors.stackContextItems['this'], true);
      var wrappedArgs =
        _.map(_.zip(self.argumentContracts, _.toArray(arguments).slice(0, self.argumentContracts.length)), function(pair, i) {
          return next(pair[0], pair[1], errors.stackContextItems.argument(pair[0].thingName ? pair[0].thingName : i), true);
        });
      var extraArgs = (!self.extraArgumentContract ? [] :
                       next(self.extraArgumentContract, _.toArray(arguments).slice(self.argumentContracts.length),
                            errors.stackContextItems.extraArguments, true));

      var result = fn.apply(wrappedThis, wrappedArgs.concat(extraArgs));
      return next(self.resultContract, result, errors.stackContextItems.result, false);
    };

    if (fn.prototype) {
      r.prototype = fn.prototype;
    }

    return r;


  };
  self.extraArgs = function(contract) {
    contract = contract || c.any;
    var self = this; return u.gentleUpdate(self, { extraArgumentContract: contract });
  };
  self.needsWrapping = true;
  self.thisArg = function (contract) { var self = this; return u.gentleUpdate(self, { thisContract: contract }); };
  self.ths = self.thisArg; // for backward compatibility
  self.returns = function (contract) { var self = this; return u.gentleUpdate(self, { resultContract: contract }); };

  self.constructs = function (prototypeFields) {
    var self = this;

    var oldWrapper = self.wrapper;

    return u.gentleUpdate(self, {

      nestedChecker: function (v) {
        var self = this;

        var missing = _.difference(_.keys(prototypeFields), _.allKeys(v.prototype));
        if (missing.length) {
          throw new errors.ContractLibraryError
          ('constructs', false,
           util.format("Some fields present in %s prototype contract are missing on the prototype: %s",
                       self.thingName ? util.format("%s's", self.thingName) : "the",
                       missing.join(', ')));
        }
      },

      wrapper: function (fn, next, context) {
        var self = this;

        // Here we are reusing the normal function wrapper function.
        // In order to do, we disable the `resultContract` since the normal wrapped
        // does not check results according to constructor-invocation semantics.
        // The actual result check is done below.
        var wrappedFnWithoutResultCheck = oldWrapper.call(u.gentleUpdate(self, { resultContract: c.any }), fn, next, context);

        var WrappedConstructor = function (/* ... */) {
          var contextHere = u.clone(context);
          contextHere.stack = u.clone(context.stack);
          contextHere.thingName = self.thingName || contextHere.thingName;

          var receivedResult = wrappedFnWithoutResultCheck.apply(this, arguments);
          contextHere.stack.push(errors.stackContextItems.result);

          // Constructor semantic according to the JavaScript standard,
          // cf. http://stackoverflow.com/a/1978474/35902
          var resultToCheck;
          if (_.isObject(receivedResult)) {
            resultToCheck = receivedResult;
          } else {
            resultToCheck = this;
          }
          var result = c.privates.checkWrapWContext(self.resultContract, resultToCheck, contextHere);
          contextHere.stack.pop();
          return result;
        };

        WrappedConstructor.prototype = Object.create(fn.prototype);

        // Recreate the constructor field, cf. https://github.com/getify/You-Dont-Know-JS/blob/master/this%20&%20object%20prototypes/ch5.md
        Object.defineProperty(WrappedConstructor.prototype, "constructor" , {
          enumerable: false,
          writable: true,
          configurable: true,
          value: fn
        });

        var newThisContract = c.isA(fn);
        _.each(prototypeFields, function (contract, k) {
          var freshContext = _.clone(context);
          freshContext.thingName = k;
          if (contract.thisContract === c.any) {
            // Functions with no specified `thisContract` are assumed to be methods
            // and given a `thisContract`
            contract = u.gentleUpdate(contract, { thisContract: newThisContract });
          }
          WrappedConstructor.prototype[k] = c.privates.checkWrapWContext(contract, WrappedConstructor.prototype[k], freshContext);
        });

        return WrappedConstructor;
      }
    });


  };

  self.toString = function () {
    var self = this;
    return "c." + self.contractName + "(" +
      (self.thisContract !== c.any ? "this: " + self.thisContract + ", " : "") +
      self.argumentContracts.join(", ") +
      (self.extraArgumentContract ? "..." + self.extraArgumentContract : "") +
      " -> " + self.resultContract + ")";
  };
  return self;
}

function fn(/* ... */) {
  return fnHelper('fn', _.toArray(arguments));
}
exports.fn = fn;


function funHelper(who, argumentContracts) {

  _.each(argumentContracts, function (argSpec, i) {
    if (!_.isObject(argSpec))
      throw new errors.ContractLibraryError
    (who, false,
     "expected an object with exactly one field to specify the name of the " +ith(i)+
     " argument, but got " + stringify(argSpec));

    if (u.isContractInstance(argSpec))
      throw new errors.ContractLibraryError
    (who, false,
     "expected a one-field object specifying the name and the contract of the "+ith(i)+
     " argument, but got a contract " + argSpec);

    var s = _.size(_.keys(argSpec));
    if (s !== 1)
      throw new errors.ContractLibraryError(who, false, "expected exactly one key to specify the name of the "+ith(i)+
                                     " arguments, but got " + stringify(s));

  });
  var contracts = _.map(argumentContracts, function(singleton) {
    var name = _.keys(singleton)[0];
    var contract = c.privates._autoToContract(singleton[name]);

    return u.gentleUpdate(contract, { thingName: name });
  });

  var toString = function () {
    var self = this;

    var argumentStrings =
      _.map(contracts, function (c) {
        return '{ ' + c.thingName + ': ' + c.toString() + ' }';
      });

    return "c." + self.contractName + "(" +
      (self.thisContract !== c.any ? "this: " + self.thisContract + ", " : "") +
      argumentStrings.join(', ') +
      (self.extraArgumentContract ? "..." + self.extraArgumentContract : "") +
      " -> " + self.resultContract + ")";
  };

  return u.gentleUpdate(fnHelper('fun', contracts), { contractName: 'fun',
                                                    toString: toString
                                                  });

}

function fun(/*...*/) {
  return funHelper('fun', _.toArray(arguments));
}
exports.fun = fun;

function method(ths /* ... */) {
  if (!u.isContractInstance(ths))
    throw new errors.ContractLibraryError('method', false, "expected a Contract for the `this` argument, by got " + stringify(ths));
  return u.gentleUpdate(funHelper('method', _.toArray(arguments).slice(1)).thisArg(ths),
                      { contractName: 'method' });
}
exports.method = method;

var oneKeyHash = fun({ valueContract: c.contract })
    .wrap(function (valueContract) {
        return c.and(
            c.hash(valueContract),
            c.pred(function (hash) { return _(hash).keys().length === 1; })
        ).rename('a hash containing exactly one key, with a value satisfying ' + valueContract.toString());
    });


// Creates a contract for a Node-style callback. The returned contract
// accepts functions whose first argument is `c.any`, and the other
// arguments are specified the same way as `c.fun`.
//
// In the Node-style callback convension, any non-null non-undefined
// value for the first argument indicates an error. When an error is
// indicated, the other arguments must not be present, else a contract
// is raise.
//
// As a special case, invoking a callback with no arguments indicates
// a success. If the success arguments' contract allows it, the
// wrapped function will receive one argument set to `undefined`.
//
// Calling `withError` on the returned contract changes the type of
// the expected error from `c.any` to the contract specified.
//
// Invoking a Node-style callback with both an error and success
// values will raise a `ContractError`.
//
// Finally, the `callback` function itself has a method
// `withDefaultError` which returns a new `callback` function. Using
// this newly created callback function will create contracts whose
// default error contract is the one given to `withDefaultError`.
//
var _makeFailureFnContract = function (errorContract) {
    return fun({ error: errorContract }).extraArgs(c.any).rename('callback');
};

var _makeSuccessFnContract = function (contracts) {
    return fun.apply(null, [{ error: c.oneOf(null, undefined) }].concat(contracts))
        .rename('callback');
};

var _makeCallback =
    function (defaultError) {
        var result =
            fun().extraArgs([oneKeyHash(c.contract)])// .returns(c.functionContract)
            .wrap(
                function callback(/*...*/) {
                    var result = fun().extraArgs(c.any);

                    result._successContract = _makeSuccessFnContract(_.toArray(arguments));

                    result._failureContract = _makeFailureFnContract(defaultError);

                    result.withError = fun({ newErrorContract: c.contract }).wrap(
                        function withError(newErrorContract) {
                            var self = this;
                            return _.extend(
                                {}, self,
                                { _failureContract: _makeFailureFnContract(newErrorContract) });
                        });

                    var oldWrapper = result.wrapper;
                    result.wrapper = function (fn, next, context) {
                        var self = this;

                        var fnWrappedForErr = self._failureContract.wrapper(fn, next, context);
                        var fnWrappedForSuccess = self._successContract.wrapper(fn, next, context);

                        return oldWrapper.call(self, function (/*...*/) {
                            var err = arguments[0];

                            if (arguments.length === 0) {
                                // Special case for a zero-argument success; provide an `undefined` first argument.
                                return fnWrappedForSuccess.apply(this, [undefined]);

                            } else if (err === null || err === undefined) {
                                // Received no error, check against the normal contract.
                                return fnWrappedForSuccess.apply(this, arguments);

                            } else if (arguments.length !== 1) {
                                // Received both an error and normal arguments, this is always wrong.
                                var msg = util.format(
                                    "Node-style callback invoked with both an error and %s success argument%s",
                                    arguments.length === 2 ? 'a' : arguments.length - 1,
                                    arguments.length > 2 ? 's' : '');
                                context.fail(new errors.ContractError(context, msg).fullContract());

                            } else {
                                // Received an error, check it.
                                return fnWrappedForErr.apply(this, arguments);
                            }
                        }, next, context);
                    };

                    result.contractName = 'callback';

                    result.toString = function () {
                        var self = this;
                        var fC = self._failureContract;
                        var sC = self._successContract;

                        return "c." + self.contractName + "(" +
                            (self.thisContract !== c.any ? "this: " + self.thisContract + ", " : "") +
                            fC.argumentContracts[0].toString() + ", " +
                            sC.argumentContracts.slice(1).join(", ") +
                            (sC.extraArgumentContract ? "..." + sC.extraArgumentContract : "") +
                            " -> " + self.resultContract + ")";
                    };

                    return result;
                }
            );

        result.withDefaultError =
            fun({ defaultErrorContract: c.contract })
            .wrap(function (defaultErrorContract) {
                return _makeCallback(defaultErrorContract);
            });

        return result;

    };

var callback = _makeCallback(c.any);

exports.callback = callback;
