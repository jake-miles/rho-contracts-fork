//  -*- js-indent-level: 2 -*-
"use strict";

/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/*jshint eqeqeq:true, bitwise:true, forin:true, immed:true, latedef: true, newcap: true, undef: true, strict:true, node:true */
/*global describe, it */

var should = require('should');
var __ = require('underscore');
var c = require('./contract');
var fs = require('fs');
var errors = require('./contract-errors');

describe('c.constructs', function () {

  describe('with a class', function () {

    class Foo {
      constructor (initialValue) {
        this.value = initialValue;
      }

      inc () {
        this.value++;
      }
    }

    var theContract = c.fun({ initialValue: c.number })
      .constructs({
        inc: c.fun().returns(c.number),
      });

    var Wrapped = theContract.wrap(Foo);

    it('can construct', function () {
      var wrapped = new Wrapped(10);

      wrapped.value.should.be.eql(10);
    });

  });

});