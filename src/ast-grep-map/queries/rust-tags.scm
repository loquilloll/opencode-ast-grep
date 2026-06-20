(struct_item
    name: (type_identifier) @name.definition.class) @definition.class
(enum_item
    name: (type_identifier) @name.definition.class) @definition.class
(union_item
    name: (type_identifier) @name.definition.class) @definition.class
(type_item
    name: (type_identifier) @name.definition.class) @definition.class
(declaration_list
    (function_item
        name: (identifier) @name.definition.method)) @definition.method
(function_item
    name: (identifier) @name.definition.function) @definition.function
(trait_item
    name: (type_identifier) @name.definition.interface) @definition.interface
(mod_item
    name: (identifier) @name.definition.module) @definition.module
(macro_definition
    name: (identifier) @name.definition.macro) @definition.macro
(call_expression
    function: (identifier) @name.reference.call) @reference.call
(call_expression
    function: (field_expression
        field: (field_identifier) @name.reference.call)) @reference.call
(macro_invocation
    macro: (identifier) @name.reference.call) @reference.call
(impl_item
    trait: (type_identifier) @name.reference.implementation) @reference.implementation
(impl_item
    type: (type_identifier) @name.reference.implementation
    !trait) @reference.implementation
