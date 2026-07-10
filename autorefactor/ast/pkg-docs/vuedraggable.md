# vuedraggable v4.1.0 README.md

<p align="center"><img width="140"src="https://raw.githubusercontent.com/SortableJS/Vue.Draggable/master/logo.svg?sanitize=true"></p>
<h1 align="center">vue.draggable.next</h1>

[![CircleCI](https://circleci.com/gh/SortableJS/vue.draggable.next.svg?style=shield)](https://circleci.com/gh/SortableJS/Vue.Draggable)
[![Coverage](https://codecov.io/gh/SortableJS/vue.draggable.next/branch/master/graph/badge.svg)](https://codecov.io/gh/SortableJS/Vue.Draggable)
[![codebeat badge](https://codebeat.co/badges/7a6c27c8-2d0b-47b9-af55-c2eea966e713)](https://codebeat.co/projects/github-com-sortablejs-vue-draggable-master)
[![GitHub open issues](https://img.shields.io/github/issues/SortableJS/vue.draggable.next.svg)](https://github.com/SortableJS/Vue.Draggable/issues?q=is%3Aopen+is%3Aissue)
[![npm download](https://img.shields.io/npm/dt/vuedraggable.svg?maxAge=30)](https://www.npmjs.com/package/vuedraggable)
[![npm download per month](https://img.shields.io/npm/dm/vuedraggable.svg)](https://www.npmjs.com/package/vuedraggable)
[![npm version](https://img.shields.io/npm/v/vuedraggable/next.svg)](https://www.npmjs.com/package/vuedraggable/v/next)
[![MIT License](https://img.shields.io/github/license/SortableJS/vue.draggable.next.svg)](https://github.com/SortableJS/vue.draggable.next/blob/master/LICENSE)


Vue component (Vue.js 3.0) allowing drag-and-drop and synchronization with view model array.

For Vue 2 and Vue 1 version check: https://github.com/SortableJS/Vue.Draggable

Based on and offering all features of [Sortable.js](https://github.com/RubaXa/Sortable)

## Demo

![demo gif](https://raw.githubusercontent.com/SortableJS/vue.draggable.next/master/example.gif)

## Live Demos

https://sortablejs.github.io/vue.draggable.next/

## Features

* Full support of [Sortable.js](https://github.com/RubaXa/Sortable) features:
    * Supports touch devices
    * Supports drag handles and selectable text
    * Smart auto-scrolling
    * Support drag and drop between different lists
    * No jQuery dependency
* Keeps in sync HTML and view model list
* Compatible with Vue.js 3.0 transition-group
* Cancellation support
* Events reporting any changes when full control is needed
* Reuse existing UI library components (such as [vuetify](https://vuetifyjs.com), [element](http://element.eleme.io/), or [vue material](https://vuematerial.io) etc...) and make them draggable using `tag` and `componentData` props


## Donate

Find this project useful? You can buy me a :coffee: or a :beer:

[![paypal](https://www.paypalobjects.com/en_US/i/btn/btn_donate_LG.gif)](https://www.paypal.com/cgi-bin/webscr?cmd=_donations&business=GYAEKQZJ4FQT2&currency_code=USD&source=url)


## Installation

### With npm or yarn 

[code]

### with direct link 
[code]

[cf example section](https://github.com/SortableJS/Vue.Draggable/tree/master/example)


## Typical use:
[code]
[code]

The `item` slot should be used to display items of the list. It receives the element value and the element index as slot-props.

### With `transition-group`:
``` html
<dra