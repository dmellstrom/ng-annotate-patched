// ng-annotate-main.js
// MIT licensed, see LICENSE file
// Copyright (c) 2013-2016 Olov Lassus <olov.lassus@gmail.com>

"use strict";
const traverse = require("./traverse");
let EOL = require("os").EOL;
const assert = require("assert");
const ngInject = require("./nginject");
const generateSourcemap = require("./generate-sourcemap");
const Lut = require("./lut");
const scopeTools = require("./scopetools");
const stableSort = require("./utils").stableSort;
const optionalAngularDashboardFramework = require("./optionals/angular-dashboard-framework");
const require_acorn_t0 = Date.now();
const require_acorn_t1 = Date.now();

const chainedRouteProvider = 1;
const chainedUrlRouterProvider = 2;
const chainedStateProvider = 3;
const chainedRegular = 4;

function match(node, ctx, matchPlugins) {
    const isMethodCall = (
        node.type === "CallExpression" &&
            node.callee.type === "MemberExpression" &&
            node.callee.computed === false
        );

    // matchInjectorInvoke must happen before matchRegular
    // to prevent false positive ($injector.invoke() outside module)
    // matchProvide must happen before matchRegular
    // to prevent regular from matching it as a short-form
    const matchMethodCalls = (isMethodCall &&
        (matchInjectorInvoke(node) || matchProvide(node, ctx) || matchRegular(node, ctx) || matchNgRoute(node) || matchMaterialShowModalOpen(node) || matchNgUi(node) || matchHttpProvider(node) || matchControllerProvider(node)));

    return matchMethodCalls ||
        (matchPlugins && matchPlugins(node)) ||
        matchDirectiveReturnObject(node) ||
        matchProviderGet(node);
}

function matchMaterialShowModalOpen(node) {
    // $mdDialog.show({.. controller: fn, resolve: {f: function($scope) {}, ..}});
    // $mdToast.show({.. controller: fn, resolve: {f: function($scope) {}, ..}});
    // $mdBottomSheet.show({.. controller: fn, resolve: {f: function($scope) {}, ..}});
    // $modal.open({.. controller: fn, resolve: {f: function($scope) {}, ..}});

    // we already know that node is a (non-computed) method call
    const callee = node.callee;
    const obj = callee.object; // identifier or expression
    const method = callee.property; // identifier
    const args = node.arguments;

    if (obj.type === "Identifier" &&
        ((["$modal", "$uibModal"].includes(obj.name) && method.name === "open") || (["$mdDialog", "$mdToast", "$mdBottomSheet"].includes(obj.name) && method.name === "show")) &&
        args.length === 1 && args[0].type === "ObjectExpression") {
        const props = args[0].properties;
        const res = [matchProp("controller", props)];
        res.push.apply(res, matchResolve(props));
        return res.filter(Boolean);
    }
    return false;
}

function getObjectExpressionReturnProperties(node) {
    // matches object return via `return`:
    // 1. function() { return {} }
    // 2. () => { return {} }
    if (node.type === "ReturnStatement" &&
        node.argument && node.argument.type === "ObjectExpression") {
        return node.argument.properties;
    }

    // matches object return via arrow function shortcut:
    // 1. () => ({})
    if (node.type === "ArrowFunctionExpression" && node.expression === true &&
        node.body.type === "ObjectExpression") {
        return node.body.properties;
    }

    return undefined;
}

function matchDirectiveReturnObject(node) {
    // only matches inside directives
    //   { .. controller: function($scope, $timeout), ...}
    const properties = getObjectExpressionReturnProperties(node);

    return limit("directive", properties &&
        matchProp("controller", properties));
}

function limit(name, node) {
    if (node && !node.$limitToMethodName) {
        node.$limitToMethodName = name;
    }
    return node;
}

function matchProviderGet(node) {
    // only matches inside providers
    // (this|self|that).$get = function($scope, $timeout)
    // { ... $get: function($scope, $timeout), ...}
    let memberExpr;
    let self;
    return limit("provider", (node.type === "AssignmentExpression" && (memberExpr = node.left).type === "MemberExpression" &&
        memberExpr.property.name === "$get" &&
        ((self = memberExpr.object).type === "ThisExpression" || (self.type === "Identifier" && ["self", "that"].includes(self.name))) &&
        node.right) ||
        (node.type === "ObjectExpression" && matchProp("$get", node.properties)));
}

function matchNgRoute(node) {
    // $routeProvider.when("path", {
    //   ...
    //   controller: function($scope) {},
    //   resolve: {f: function($scope) {}, ..}
    // })

    // we already know that node is a (non-computed) method call
    const callee = node.callee;
    const obj = callee.object; // identifier or expression
    if (!(obj.$chained === chainedRouteProvider || (obj.type === "Identifier" && obj.name === "$routeProvider"))) {
        return false;
    }
    node.$chained = chainedRouteProvider;

    const method = callee.property; // identifier
    if (method.name !== "when") {
        return false;
    }

    const args = node.arguments;
    if (args.length !== 2) {
        return false;
    }
    const configArg = last(args);
    if (configArg.type !== "ObjectExpression") {
        return false;
    }

    const props = configArg.properties;
    const res = [
        matchProp("controller", props)
    ];
    // {resolve: ..}
    res.push.apply(res, matchResolve(props));

    const filteredRes = res.filter(Boolean);
    return (filteredRes.length === 0 ? false : filteredRes);
}

function matchNgUi(node) {
    // $stateProvider.state("myState", {
    //     ...
    //     controller: function($scope)
    //     controllerProvider: function($scope)
    //     templateProvider: function($scope)
    //     onEnter: function($scope)
    //     onExit: function($scope)
    // });
    // $stateProvider.state("myState", {... resolve: {f: function($scope) {}, ..} ..})
    // $stateProvider.state("myState", {... params: {params: {simple: function($scope) {}, inValue: { value: function($scope) {} }} ..})
    // $stateProvider.state("myState", {... views: {... somename: {... controller: fn, controllerProvider: fn, templateProvider: fn, resolve: {f: fn}}}})
    //
    // stateHelperProvider.setNestedState({ sameasregularstate, children: [sameasregularstate, ..]})
    // stateHelperProvider.setNestedState({ sameasregularstate, children: [sameasregularstate, ..]}, true)
    //
    // $urlRouterProvider.when(.., function($scope) {})
    //
    // $modal.open see matchMaterialShowModalOpen

    // we already know that node is a (non-computed) method call
    const callee = node.callee;
    const obj = callee.object; // identifier or expression
    const method = callee.property; // identifier
    const args = node.arguments;

    // shortcut for $urlRouterProvider.when(.., function($scope) {})
    if (obj.$chained === chainedUrlRouterProvider || (obj.type === "Identifier" && obj.name === "$urlRouterProvider")) {
        node.$chained = chainedUrlRouterProvider;

        if (method.name === "when" && args.length >= 1) {
            return last(args);
        }
        return false;
    }

    // everything below is for $stateProvider and stateHelperProvider alone
    if (!(obj.$chained === chainedStateProvider || (obj.type === "Identifier" && ["$stateProvider", "stateHelperProvider"].includes(obj.name)))) {
        return false;
    }
    node.$chained = chainedStateProvider;

    if (!["state", "setNestedState"].includes(method.name)) {
        return false;
    }

    // $stateProvider.state({ ... }) and $stateProvider.state("name", { ... })
    // stateHelperProvider.setNestedState({ .. }) and stateHelperProvider.setNestedState({ .. }, true)
    if (!(args.length >= 1 && args.length <= 2)) {
        return false;
    }

    const configArg = (method.name === "state" ? last(args) : args[0]);

    const res = [];

    recursiveMatch(configArg);

    const filteredRes = res.filter(Boolean);
    return (filteredRes.length === 0 ? false : filteredRes);


    function recursiveMatch(objectExpressionNode) {
        if (!objectExpressionNode || objectExpressionNode.type !== "ObjectExpression") {
            return false;
        }

        const properties = objectExpressionNode.properties;

        matchStateProps(properties, res);

        const childrenArrayExpression = matchProp("children", properties);
        const children = childrenArrayExpression && childrenArrayExpression.elements;

        if (!children) {
            return;
        }
        children.forEach(recursiveMatch);
    }

    function matchStateProps(props, res) {
        const simple = [
            matchProp("controller", props),
            matchProp("controllerProvider", props),
            matchProp("templateProvider", props),
            matchProp("onEnter", props),
            matchProp("onExit", props),
        ];
        res.push.apply(res, simple);

        // {resolve: ..}
        res.push.apply(res, matchResolve(props));

        // {params: {simple: function($scope) {}, inValue: { value: function($scope) {} }}
        const a = matchProp("params", props);
        if (a && a.type === "ObjectExpression") {
            a.properties.forEach(function(prop) {
                if (prop.value.type === "ObjectExpression") {
                    res.push(matchProp("value", prop.value.properties));
                } else {
                    res.push(prop.value);
                }
            });
        }

        // {view: ...}
        const viewObject = matchProp("views", props);
        if (viewObject && viewObject.type === "ObjectExpression") {
            viewObject.properties.forEach(function(prop) {
                if (prop.value.type === "ObjectExpression") {
                    res.push(matchProp("controller", prop.value.properties));
                    res.push(matchProp("controllerProvider", prop.value.properties));
                    res.push(matchProp("templateProvider", prop.value.properties));
                    res.push.apply(res, matchResolve(prop.value.properties));
                }
            });
        }
    }
}

function matchInjectorInvoke(node) {
    // $injector.invoke(function($compile) { ... });

    // we already know that node is a (non-computed) method call
    const callee = node.callee;
    const obj = callee.object; // identifier or expression
    const method = callee.property; // identifier

    return method.name === "invoke" &&
        obj.type === "Identifier" && obj.name === "$injector" &&
        node.arguments.length >= 1 && node.arguments;
}

function matchHttpProvider(node) {
    // $httpProvider.interceptors.push(function($scope) {});
    // $httpProvider.responseInterceptors.push(function($scope) {});

    // we already know that node is a (non-computed) method call
    const callee = node.callee;
    const obj = callee.object; // identifier or expression
    const method = callee.property; // identifier

    return (method.name === "push" &&
        obj.type === "MemberExpression" && !obj.computed &&
        obj.object.name === "$httpProvider" && ["interceptors", "responseInterceptors"].includes(obj.property.name) &&
        node.arguments.length >= 1 && node.arguments);
}

function matchControllerProvider(node) {
    // $controllerProvider.register("foo", function($scope) {});

    // we already know that node is a (non-computed) method call
    const callee = node.callee;
    const obj = callee.object; // identifier or expression
    const method = callee.property; // identifier
    const args = node.arguments;

    const target = obj.type === "Identifier" && obj.name === "$controllerProvider" &&
        method.name === "register" && args.length === 2 && args[1];

    if (target) {
        target.$methodName = method.name;
    }
    return target;
}

function matchProvide(node, ctx) {
    // $provide.decorator("foo", function($scope) {});
    // $provide.service("foo", function($scope) {});
    // $provide.factory("foo", function($scope) {});
    // $provide.provider("foo", function($scope) {});

    // we already know that node is a (non-computed) method call
    const callee = node.callee;
    const obj = callee.object; // identifier or expression
    const method = callee.property; // identifier
    const args = node.arguments;

    const target = obj.type === "Identifier" && obj.name === "$provide" &&
        ["decorator", "service", "factory", "provider"].includes(method.name) &&
        args.length === 2 && args[1];

    if (target) {
        target.$methodName = method.name;

        if (ctx.rename) {
            // for eventual rename purposes
            return args;
        }
    }
    return target;
}

function matchRegular(node, ctx) {
    // we already know that node is a (non-computed) method call
    const callee = node.callee;
    const obj = callee.object; // identifier or expression
    const method = callee.property; // identifier

    // short-cut implicit config special case:
    // angular.module("MyMod", function(a) {})
    if (obj.name === "angular" && method.name === "module") {
        const args = node.arguments;
        if (args.length >= 2) {
            node.$chained = chainedRegular;
            return last(args);
        }
    }

    // hardcoded exception: foo.decorator is generally considered a short-form
    // declaration but $stateProvider.decorator is not. see https://github.com/olov/ng-annotate/issues/82
    if (obj.name === "$stateProvider" && method.name === "decorator") {
        return false;
    }

    const matchAngularModule = (obj.$chained === chainedRegular || isReDef(obj, ctx) || isLongDef(obj)) &&
        ["provider", "value", "constant", "bootstrap", "config", "factory", "directive", "filter", "run", "controller", "service", "animation", "invoke", "store", "decorator", "component"].includes(method.name);
    if (!matchAngularModule) {
        return false;
    }
    node.$chained = chainedRegular;

    if (["value", "constant", "bootstrap"].includes(method.name)) {
        return false; // affects matchAngularModule because of chaining
    }

    const args = node.arguments;
    let target = (["config", "run"].includes(method.name) ?
        args.length === 1 && args[0] :
        args.length === 2 && args[0].type === "Literal" && typeof args[0].value === "string" && args[1]);

    if (method.name === "component") {
        const controllerProp = (target && target.type === "ObjectExpression" && matchProp("controller", target.properties));
        if (!controllerProp) {
            return false;
        }
        target = controllerProp;
    }

    if (target) {
        target.$methodName = method.name;
    }

    if (ctx.rename && args.length === 2 && target) {
        // for eventual rename purposes
        const somethingNameLiteral = args[0];
        return [somethingNameLiteral, target];
    }
    return target;
}

// matches with default regexp
//   *.controller("MyCtrl", function($scope, $timeout) {});
//   *.*.controller("MyCtrl", function($scope, $timeout) {});
// matches with --regexp "^require(.*)$"
//   require("app-module").controller("MyCtrl", function($scope) {});
function isReDef(node, ctx) {
    return ctx.re.test(ctx.srcForRange(node.range));
}

// Long form: angular.module(*).controller("MyCtrl", function($scope, $timeout) {});
function isLongDef(node) {
    return node.callee &&
        node.callee.object && node.callee.object.name === "angular" &&
        node.callee.property && node.callee.property.name === "module";
}

function last(arr) {
    return arr[arr.length - 1];
}

function matchProp(name, props) {
    for (let i = 0; i < props.length; i++) {
        const prop = props[i];
        if ((prop.key.type === "Identifier" && prop.key.name === name) ||
            (prop.key.type === "Literal" && prop.key.value === name)) {
            return prop.value; // FunctionExpression or ArrayExpression
        }
    }
    return null;
}

function matchResolve(props) {
    const resolveObject = matchProp("resolve", props);
    if (resolveObject && resolveObject.type === "ObjectExpression") {
        return resolveObject.properties.map(function(prop) {
            return prop.value;
        });
    }
    return [];
};

function renamedString(ctx, originalString) {
    if (ctx.rename) {
        return ctx.rename.get(originalString) || originalString;
    }
    return originalString;
}

function stringify(ctx, arr, quot) {
    return "[" + arr.map(function(arg) {
        return quot + renamedString(ctx, arg.name) + quot;
    }).join(", ") + "]";
}

function insertArray(ctx, functionExpression, positioningNode, fragments, quot) {
    const args = stringify(ctx, functionExpression.params, quot);

    fragments.push({
        start: positioningNode.range[0],
        end: positioningNode.range[0],
        str: args.slice(0, -1) + ", ",
        loc: {
            start: positioningNode.loc.start,
            end: positioningNode.loc.start
        }
    });
    fragments.push({
        start: positioningNode.range[1],
        end: positioningNode.range[1],
        str: "]",
        loc: {
            start: positioningNode.loc.end,
            end: positioningNode.loc.end
        }
    });
}

function replaceArray(ctx, array, fragments, quot) {
    const functionExpression = last(array.elements);

    if (functionExpression.params.length === 0) {
        return removeArray(array, fragments);
    }

    const args = stringify(ctx, functionExpression.params, quot);
    fragments.push({
        start: array.range[0],
        end: functionExpression.range[0],
        str: args.slice(0, -1) + ", ",
        loc: {
            start: array.loc.start,
            end: functionExpression.loc.start
        }
    });
}

function removeArray(array, fragments) {
    const functionExpression = last(array.elements);

    fragments.push({
        start: array.range[0],
        end: functionExpression.range[0],
        str: "",
        loc: {
            start: array.loc.start,
            end: functionExpression.loc.start
        }
    });
    fragments.push({
        start: functionExpression.range[1],
        end: array.range[1],
        str: "",
        loc: {
            start: functionExpression.loc.end,
            end: array.loc.end
        }
    });
}

function renameProviderDeclarationSite(ctx, literalNode, fragments) {
    fragments.push({
        start: literalNode.range[0] + 1,
        end: literalNode.range[1] - 1,
        str: renamedString(ctx, literalNode.value),
        loc: {
            start: {
                line: literalNode.loc.start.line,
                column: literalNode.loc.start.column + 1
            }, end: {
                line: literalNode.loc.end.line,
                column: literalNode.loc.end.column - 1
            }
        }
    });
}

function judgeSuspects(ctx) {
    const mode = ctx.mode;
    const fragments = ctx.fragments;
    const quot = ctx.quot;
    const blocked = ctx.blocked;

    const suspects = makeUnique(ctx.suspects, 1);

    for (let n = 0; n < 42; n++) {
        // could be while(true), above is just a safety-net
        // in practice it will loop just a couple of times
        propagateModuleContextAndMethodName(suspects);
        if (!setChainedAndMethodNameThroughIifesAndReferences(suspects)) {
            break;
        }
    }

    const interimSuspects = suspects.map(function(node) {
        if (isConstructorWithArgs(node)) {
            while (node = node.$parent) {
                if (node.type === "ExpressionStatement" || isClassExpression(node) || isClassDeclaration(node)) break;
            }

            node.$chained = chainedRegular;
        }
        return node;
    });

    // create final suspects by jumping, following, uniq'ing, blocking
    const finalSuspects = makeUnique(interimSuspects.map(function(target) {
        const jumped = jumpOverIife(target);
        const jumpedAndFollowed = followReference(jumped) || jumped;

        if (target.$limitToMethodName && target.$limitToMethodName !== "*never*" && findOuterMethodName(target) !== target.$limitToMethodName) {
            return null;
        }

        if (blocked.indexOf(jumpedAndFollowed) >= 0) {
            return null;
        }

        return jumpedAndFollowed;
    }).filter(Boolean), 2);

    finalSuspects.forEach(function(target) {
        if (target.$chained !== chainedRegular) {
            return;
        }

        let constructor;

        if (mode === "rebuild" && isAnnotatedArray(target)) {
            replaceArray(ctx, target, fragments, quot);
        } else if (mode === "remove" && isAnnotatedArray(target)) {
            removeArray(target, fragments);
        } else if (["add", "rebuild"].includes(mode) && isFunctionOrArrowFunctionExpressionWithArgs(target)) {
            insertArray(ctx, target, target, fragments, quot);
        } else if (["add", "rebuild"].includes(mode) && isClassExpression(target) && (constructor = findClassConstructorWithArgs(target))) {
            insertArray(ctx, constructor.value, target, fragments, quot);
        } else if (isGenericProviderName(target)) {
            renameProviderDeclarationSite(ctx, target, fragments);
        } else {
            // if it's not array or function-expression, then it's a candidate for foo.$inject = [..]
            judgeInjectArraySuspect(target, ctx);
        }
    });


    function propagateModuleContextAndMethodName(suspects) {
        suspects.forEach(function(target) {
            if (target.$chained !== chainedRegular && isInsideModuleContext(target)) {
                target.$chained = chainedRegular;
            }

            if (!target.$methodName) {
                const methodName = findOuterMethodName(target);
                if (methodName) {
                    target.$methodName = methodName;
                }
            }
        });
    }

    function findOuterMethodName(node) {
        for (; node && !node.$methodName; node = node.$parent) {
        }
        return node ? node.$methodName : null;
    }

    function setChainedAndMethodNameThroughIifesAndReferences(suspects) {
        let modified = false;
        suspects.forEach(function(target) {
            const jumped = jumpOverIife(target);
            if (jumped !== target) { // we did skip an IIFE
                if (target.$chained === chainedRegular && jumped.$chained !== chainedRegular) {
                    modified = true;
                    jumped.$chained = chainedRegular;
                }
                if (target.$methodName && !jumped.$methodName) {
                    modified = true;
                    jumped.$methodName = target.$methodName;
                }
            }

            const jumpedAndFollowed = followReference(jumped) || jumped;
            if (jumpedAndFollowed !== jumped) { // we did follow a reference
                if (jumped.$chained === chainedRegular && jumpedAndFollowed.$chained !== chainedRegular) {
                    modified = true;
                    jumpedAndFollowed.$chained = chainedRegular;
                }
                if (jumped.$methodName && !jumpedAndFollowed.$methodName) {
                    modified = true;
                    jumpedAndFollowed.$methodName = jumped.$methodName;
                }
            }
        });
        return modified;
    }

    function isInsideModuleContext(node) {
        let $parent = node.$parent;
        for (; $parent && $parent.$chained !== chainedRegular; $parent = $parent.$parent) {
        }
        return Boolean($parent);
    }

    function makeUnique(suspects, val) {
        return suspects.filter(function(target) {
            if (target.$seen === val) {
                return false;
            }
            target.$seen = val;
            return true;
        });
    }
}

function followReference(node) {
    if (!scopeTools.isReference(node)) {
        return null;
    }

    const scope = node.$scope.lookup(node.name);
    if (!scope) {
        return null;
    }

    const parent = scope.getNode(node.name).$parent;
    const kind = scope.getKind(node.name);
    if (!parent) {
        return null;
    }
    const ptype = parent.type;

    if (["const", "let", "var"].includes(kind)) {
        assert(ptype === "VariableDeclarator");
        // {type: "VariableDeclarator", id: {type: "Identifier", name: "foo"}, init: ..}
        return parent;
    } else if (kind === "fun") {
        assert(ptype === "FunctionDeclaration" || isFunctionOrArrowFunctionExpression(ptype));
        // FunctionDeclaration is the common case, i.e.
        // function foo(a, b) {}

        // FunctionExpression is only applicable for cases similar to
        // var f = function asdf(a,b) { mymod.controller("asdf", asdf) };
        return parent;
    }

    // other kinds should not be handled ("param", "caught")

    return null;
}

// O(srclength) so should only be used for debugging purposes, else replace with lut
function posToLine(pos, src) {
    if (pos >= src.length) {
        pos = src.length - 1;
    }

    if (pos <= -1) {
        return -1;
    }

    let line = 1;
    for (let i = 0; i < pos; i++) {
        if (src[i] === "\n") {
            ++line;
        }
    }

    return line;
}

function firstNonPrologueStatement(body) {
    for (let i = 0; i < body.length; i++) {
        if (body[i].type !== "ExpressionStatement") {
            return body[i];
        }

        const expr = body[i].expression;
        const isStringLiteral = (expr.type === "Literal" && typeof expr.value === "string");
        if (!isStringLiteral) {
            return body[i];
        }
    }
    return null;
}

function judgeInjectArraySuspect(node, ctx) {
    // onode is a top-level node (inside function block), later verified
    // node is inner match, descent in multiple steps
    let onode = null;

    if (["ExportDefaultDeclaration", "ExportNamedDeclaration"].includes(node.type)) {
        onode = node;
        node = node.declaration;
    }

    if (node.type === "VariableDeclaration") {
        // suspect can only be a VariableDeclaration (statement) in case of
        // explicitly marked via /*@ngInject*/, not via references because
        // references follow to VariableDeclarator (child)

        // /*@ngInject*/ var foo = function($scope) {} and

        if (node.declarations.length !== 1) {
            // more than one declarator => exit
            return;
        }

        // one declarator => jump over declaration into declarator
        // rest of code will treat it as any (referenced) declarator
        node = node.declarations[0];
    }

    let declaratorName = null;
    if (node.type === "VariableDeclarator") {
        if (onode === null) {
            onode = node.$parent;
        }
        declaratorName = node.id.name;
        node = node.init; // var foo = ___;
    } else if (onode === null) {
        onode = node;
    }

    if (onode.$parent && ["ExportDefaultDeclaration", "ExportNamedDeclaration"].includes(onode.$parent.type)) {
        // export var x = function($scope) { "ngInject"; }
        onode = onode.$parent;
    }

    // suspect must be inside of a block or at the top-level (i.e. inside of node.$parent.body[])
    if (!node || !onode.$parent || !["Program", "BlockStatement"].includes(onode.$parent.type)) {
        return;
    }

    const insertPos = {
        pos: onode.range[1],
        loc: onode.loc.end
    };
    const isSemicolonTerminated = (ctx.src[insertPos.pos - 1] === ";");

    node = jumpOverIife(node);

    let constructor;

    if ((isClassExpression(node) || isClassDeclaration(node)) && (constructor = ctx.findClassConstructorWithArgs(node))) {
        // /*@ngInject*/ class Foo { constructor($scope) {} }
        // /*@ngInject*/ Foo = class { constructor($scope) {} }

        const className = node.id ? node.id.name : declaratorName;
        assert(className);

        addRemoveInjectArray(
            constructor.value.params,
            insertPos,
            className);

    } else if (node.type === "ExpressionStatement" && node.expression.type === "AssignmentExpression" &&
               isClassExpression(node.expression.right) && (constructor = ctx.findClassConstructorWithArgs(node.expression.right))) {
        // foo.bar[0] = /*@ngInject*/ class($scope) {}

        const className = ctx.srcForRange(node.expression.left.range);

        addRemoveInjectArray(
            constructor.value.params,
            isSemicolonTerminated ? insertPos : {
                pos: node.expression.right.range[1],
                loc: node.expression.right.loc.end
            },
            className);

    } else if (node.type === "ArrowFunctionExpression" && onode.type === "ExportDefaultDeclaration") {
        // not implemented
        // this is a default exported arrow function like:
        // - export default (a, b) => {}
    } else if (ctx.isFunctionOrArrowFunctionExpressionWithArgs(node)) {
        // var x = 1, y = function(a,b) {}, z;

        assert(declaratorName);
        addRemoveInjectArray(
            node.params,
            isSemicolonTerminated ? insertPos : {
                pos: node.range[1],
                loc: node.loc.end
            },
            declaratorName);

    } else if (ctx.isFunctionDeclarationWithArgs(node)) {
        // /*@ngInject*/ function foo($scope) {}

        addRemoveInjectArray(
            node.params,
            insertPos,
            node.id.name);

    } else if (node.type === "ExpressionStatement" && node.expression.type === "AssignmentExpression" &&
        ctx.isFunctionOrArrowFunctionExpressionWithArgs(node.expression.right)) {
        // /*@ngInject*/ foo.bar[0] = function($scope) {}

        const name = ctx.srcForRange(node.expression.left.range);
        addRemoveInjectArray(
            node.expression.right.params,
            isSemicolonTerminated ? insertPos : {
                pos: node.expression.right.range[1],
                loc: node.expression.right.loc.end
            },
            name);

    } else if (node = followReference(node)) {
        // node was a reference and followed node now is either a
        // FunctionDeclaration or a VariableDeclarator
        // => recurse

        judgeInjectArraySuspect(node, ctx);
    }


    function getIndent(pos) {
        const src = ctx.src;
        const lineStart = src.lastIndexOf("\n", pos - 1) + 1;
        let i = lineStart;
        for (; src[i] === " " || src[i] === "\t"; i++) {
        }
        return src.slice(lineStart, i);
    }

    function addRemoveInjectArray(params, posAfterFunctionDeclaration, name) {
        // if an existing something.$inject = [..] exists then is will always be recycled when rebuilding

        const indent = getIndent(posAfterFunctionDeclaration.pos);

        let foundSuspectInBody = false;
        let existingExpressionStatementWithArray = null;
        let nodeAfterExtends = null;
        onode.$parent.body.forEach(function(bnode, idx) {
            if (bnode === onode) {
                foundSuspectInBody = true;
            }

            if (hasInjectArray(bnode)) {
                if (existingExpressionStatementWithArray) {
                    const first = posToLine(existingExpressionStatementWithArray.range[0], ctx.src);
                    const second = posToLine(bnode.range[0], ctx.src);
                    throw `conflicting inject arrays at line ${first} and ${second}`;
                }
                existingExpressionStatementWithArray = bnode;
            }

            let e;
            if (!nodeAfterExtends && !foundSuspectInBody && bnode.type === "ExpressionStatement" && (e = bnode.expression).type === "CallExpression" && e.callee.type === "Identifier" && e.callee.name === "__extends") {
                const nextStatement = onode.$parent.body[idx + 1];
                if (nextStatement) {
                    nodeAfterExtends = nextStatement;
                }
            }
        });
        assert(foundSuspectInBody);
        if (onode.type === "FunctionDeclaration") {
            if (!nodeAfterExtends) {
                nodeAfterExtends = firstNonPrologueStatement(onode.$parent.body);
            }
            if (nodeAfterExtends && !existingExpressionStatementWithArray) {
                posAfterFunctionDeclaration = skipPrevNewline(nodeAfterExtends.range[0], nodeAfterExtends.loc.start);
            }
        }

        function hasInjectArray(node) {
            let lvalue;
            let assignment;
            return (node && node.type === "ExpressionStatement" && (assignment = node.expression).type === "AssignmentExpression" &&
                assignment.operator === "=" &&
                (lvalue = assignment.left).type === "MemberExpression" &&
                ((lvalue.computed === false && ctx.srcForRange(lvalue.object.range) === name && lvalue.property.name === "$inject") ||
                    (lvalue.computed === true && ctx.srcForRange(lvalue.object.range) === name && lvalue.property.type === "Literal" && lvalue.property.value === "$inject")));
        }

        function skipPrevNewline(pos, loc) {
            let prevLF = ctx.src.lastIndexOf("\n", pos);
            if (prevLF === -1) {
                return { pos: pos, loc: loc };
            }
            if (prevLF >= 1 && ctx.src[prevLF - 1] === "\r") {
                --prevLF;
            }

            if (/\S/g.test(ctx.src.slice(prevLF, pos - 1))) { // any non-whitespace chars between prev newline and pos?
                return { pos: pos, loc: loc };
            }

            return {
                pos: prevLF,
                loc: {
                    line: loc.line - 1,
                    column: prevLF - ctx.src.lastIndexOf("\n", prevLF) - 1,
                }
            };
        }

        if (ctx.mode === "rebuild" && existingExpressionStatementWithArray) {
            const strNoWhitespace = `${name}.$inject = ${ctx.stringify(ctx, params, ctx.quot)};`;
            ctx.fragments.push({
                start: existingExpressionStatementWithArray.range[0],
                end: existingExpressionStatementWithArray.range[1],
                str: strNoWhitespace,
                loc: {
                    start: existingExpressionStatementWithArray.loc.start,
                    end: existingExpressionStatementWithArray.loc.end
                }
            });
        } else if (ctx.mode === "remove" && existingExpressionStatementWithArray) {
            const start = skipPrevNewline(existingExpressionStatementWithArray.range[0], existingExpressionStatementWithArray.loc.start);
            ctx.fragments.push({
                start: start.pos,
                end: existingExpressionStatementWithArray.range[1],
                str: "",
                loc: {
                    start: start.loc,
                    end: existingExpressionStatementWithArray.loc.end
                }
            });
        } else if (["add", "rebuild"].includes(ctx.mode) && !existingExpressionStatementWithArray) {
            const str = `${EOL}${indent}${name}.$inject = ${ctx.stringify(ctx, params, ctx.quot)};`;
            ctx.fragments.push({
                start: posAfterFunctionDeclaration.pos,
                end: posAfterFunctionDeclaration.pos,
                str: str,
                loc: {
                    start: posAfterFunctionDeclaration.loc,
                    end: posAfterFunctionDeclaration.loc
                }
            });
        }
    }
}

function jumpOverIife(node) {
    if (node.type !== "CallExpression") {
        return node;
    }

    const outerfn = node.callee;

    /**
     * IIFE as in:
     *  - (() => 'value')()
     */
    if (outerfn.type === "ArrowFunctionExpression" && outerfn.expression) {
        return outerfn.body;
    }

    /**
     * IIFE as in:
     *  - (() => { return 'value' })()
     *  - (function { return 'value' })()
     *
     *  needs to loop over children, as the return could be anywhere inside the body, as in:
     *  - (function { console.log('something before'); return 'value'; console.log('something behind, but valid javascript'); }()
     */
    if (isFunctionOrArrowFunctionExpression(outerfn.type)) {
        const outerbody = outerfn.body.body;
        for (let i = 0; i < outerbody.length; i++) {
            const statement = outerbody[i];
            if (statement.type === "ReturnStatement") {
                return statement.argument;
            }
        }
    }

    return node;
}

function addModuleContextDependentSuspect(target, ctx) {
    ctx.suspects.push(target);
}

function addModuleContextIndependentSuspect(target, ctx) {
    target.$chained = chainedRegular;
    ctx.suspects.push(target);
}

function isAnnotatedArray(node) {
    if (node.type !== "ArrayExpression") {
        return false;
    }
    const elements = node.elements;

    // last should be a function expression
    if (elements.length === 0 || !isFunctionOrArrowFunctionExpression(last(elements).type)) {
        return false;
    }

    // all but last should be string literals
    for (let i = 0; i < elements.length - 1; i++) {
        const n = elements[i];
        if (n.type !== "Literal" || typeof n.value !== "string") {
            return false;
        }
    }

    return true;
}

function isConstructorWithArgs (node) {
    return node.kind === 'constructor' && node.value.params.length >= 1;
}
function isClassExpression(node) {
  return node.type === "ClassExpression";
}
function isClassDeclaration(node) {
  return node.type === "ClassDeclaration";
}
function isFunctionOrArrowFunctionExpression(type) {
    return type === "FunctionExpression" || type === "ArrowFunctionExpression";
}
function isFunctionOrArrowFunctionExpressionWithArgs(node) {
    return isFunctionOrArrowFunctionExpression(node.type) && node.params.length >= 1;
}
function isFunctionDeclarationWithArgs(node) {
    // For `export default function() {...}`, `id` is null, which means
    // we cannot inject it. So ignore that.
    return node.type === "FunctionDeclaration" && node.params.length >= 1 && node.id !== null;
}
function isGenericProviderName(node) {
    return node.type === "Literal" && typeof node.value === "string";
}
function findClassConstructorWithArgs(classFunction) {
    return classFunction.body.body.find(isConstructorWithArgs);
}

function uniqifyFragments(fragments) {
    // must do in-place modification of ctx.fragments because shared reference

    const map = Object.create(null);
    for (let i = 0; i < fragments.length; i++) {
        const frag = fragments[i];
        const str = JSON.stringify({start: frag.start, end: frag.end, str: frag.str});
        if (map[str]) {
            fragments.splice(i, 1); // remove
            i--;
        } else {
            map[str] = true;
        }
    }
}

const allOptionals = {
    "angular-dashboard-framework": optionalAngularDashboardFramework,
};

// Alters a string by replacing multiple range fragments in one fast pass.
// fragments is a list of {start: index, end: index, str: string to replace with}.
// The fragments do not need to be sorted but must not overlap.
function alter(str, fragments) {
    // stableSort isn't in-place so no need to copy array first
    const sortedFragments = stableSort(fragments, (a, b) => a.start - b.start);
    const outs = [];
    let pos = 0;
    for (const frag of sortedFragments) {
        assert(pos <= frag.start);
        assert(frag.start <= frag.end);
        outs.push(str.slice(pos, frag.start));
        outs.push(frag.str);
        pos = frag.end;
    }
    outs.push(str.slice(pos));
    return outs.join("");
}

module.exports = function ngAnnotate(src, options) {
    if (options.list) {
        return {
            list: Object.keys(allOptionals).sort(),
        };
    }

    const mode = (options.add && options.remove ? "rebuild" :
        options.remove ? "remove" :
            options.add ? "add" : null);

    if (!mode) {
        return {src: src};
    }

    const quot = options.single_quotes ? "'" : '"';
    const re = (options.regexp ? new RegExp(options.regexp) : /^[a-zA-Z0-9_\$\.\s]+$/);
    const rename = new Map();
    if (options.rename) {
        options.rename.forEach(function(value) {
            rename.set(value.from, value.to);
        });
    }
    let ast;
    const stats = {};

    // detect newline and override os.EOL
    const lf = src.lastIndexOf("\n");
    if (lf >= 1) {
        EOL = (src[lf - 1] === "\r" ? "\r\n" : "\n");
    }

    // [{type: "Block"|"Line", value: str, range: [from,to]}, ..]
    let comments = [];

    try {
        const acorn = require("acorn");
        stats.parser_require_t0 = require_acorn_t0;
        stats.parser_require_t1 = require_acorn_t1;
        stats.parser_parse_t0 = Date.now();
        // acorn
        ast = acorn.Parser.parse(src, Object.assign({
            ecmaVersion: 11,
            allowImportExportEverywhere: true,
            allowReturnOutsideFunction: true,
            locations: true,
            ranges: true,
            onComment: comments,
            plugins: {}, // just having the key triggers plugin regardless of value
        }, options.acornOptions));
        stats.parser_parse_t1 = Date.now();
    } catch(e) {
        return {
            errors: ["error: couldn't process source due to parse error", e.message],
        };
    }

    // append a dummy-node to ast so that lut.findNodeFromPos(lastPos) returns something
    ast.body.push({
        type: "DebuggerStatement",
        range: [ast.range[1], ast.range[1]],
        loc: {
            start: ast.loc.end,
            end: ast.loc.end
        }
    });

    // all source modifications are built up as operations in the
    // fragments array, later sent to alter in one shot
    const fragments = [];

    // suspects is built up with suspect nodes by match.
    // A suspect node will get annotations added / removed if it
    // fulfills the arrayexpression or functionexpression look,
    // and if it is in the correct context (inside an angular
    // module definition)
    const suspects = [];

    // blocked is an array of blocked suspects. Any target node
    // (final, i.e. IIFE-jumped, reference-followed and such) included
    // in blocked will be ignored by judgeSuspects
    const blocked = [];

    // Position information for all nodes in the AST,
    // used for sourcemap generation
    const nodePositions = [];

    const lut = new Lut(ast, src, options);

    scopeTools.setupScopeAndReferences(ast, options);

    const ctx = {
        mode: mode,
        quot: quot,
        src: src,
        srcForRange: function(range) {
            return src.slice(range[0], range[1]);
        },
        re: re,
        rename: rename,
        comments: comments,
        fragments: fragments,
        suspects: suspects,
        blocked: blocked,
        lut: lut,
        isClassExpression: isClassExpression,
        isClassDeclaration: isClassDeclaration,
        isFunctionOrArrowFunctionExpressionWithArgs: isFunctionOrArrowFunctionExpressionWithArgs,
        isFunctionDeclarationWithArgs: isFunctionDeclarationWithArgs,
        isAnnotatedArray: isAnnotatedArray,
        findClassConstructorWithArgs: findClassConstructorWithArgs,
        addModuleContextDependentSuspect: addModuleContextDependentSuspect,
        addModuleContextIndependentSuspect: addModuleContextIndependentSuspect,
        stringify: stringify,
        nodePositions: nodePositions,
        matchResolve: matchResolve,
        matchProp: matchProp,
        last: last,
    };

    // setup optionals
    const optionals = options.enable || [];
    for (let i = 0; i < optionals.length; i++) {
        const optional = String(optionals[i]);
        if (!allOptionals.hasOwnProperty(optional)) {
            return {
                errors: ["error: found no optional named " + optional],
            };
        }
    }
    const optionalsPlugins = optionals.map(function(optional) {
        return allOptionals[optional];
    });

    const plugins = [].concat(optionalsPlugins, options.plugin || []);

    function matchPlugins(node, isMethodCall) {
        for (let i = 0; i < plugins.length; i++) {
            const res = plugins[i].match(node, isMethodCall);
            if (res) {
                return res;
            }
        }
        return false;
    }
    const matchPluginsOrNull = (plugins.length === 0 ? null : matchPlugins);

    ngInject.inspectComments(ctx);
    plugins.forEach(function(plugin) {
        plugin.init(ctx);
    });

    traverse(ast, {pre: function(node) {
        ngInject.inspectNode(node, ctx);

    }, post: function(node) {
        ctx.nodePositions.push(node.loc.start);
        let targets = match(node, ctx, matchPluginsOrNull);
        if (!targets) {
            return;
        }
        if (!Array.isArray(targets)) {
            targets = [targets];
        }

        for (let i = 0; i < targets.length; i++) {
            addModuleContextDependentSuspect(targets[i], ctx);
        }
    }}, options);

    try {
        judgeSuspects(ctx);
    } catch(e) {
        return {
            errors: ["error: " + e],
        };
    }

    uniqifyFragments(ctx.fragments);

    const out = alter(src, fragments);
    const result = {
        src: out,
        _stats: stats,
    };

    if (options.map) {
        if (typeof(options.map) !== 'object')
            options.map = {};
        stats.sourcemap_t0 = Date.now();
        generateSourcemap(result, src, nodePositions, fragments, options.map);
        stats.sourcemap_t1 = Date.now();
    }

    return result;
};
