import { indent, indentMultiline, transformComment } from '@graphql-codegen/visitor-plugin-common';
import { pascalCase, constantCase, camelCase } from 'change-case';
import dedent from 'ts-dedent';
import { isArray } from 'util';
import { AppSyncModelVisitor, CodeGenField, CodeGenModel, ParsedAppSyncModelConfig, RawAppSyncModelConfig } from './appsync-visitor';

import { JavaDeclarationBlock } from '../languages/java-declaration-block';
import {
  GENERATED_PACKAGE_NAME,
  LOADER_CLASS_NAME,
  CLASS_IMPORT_PACKAGES,
  ENUM_IMPORT_PACKAGES,
  LOADER_IMPORT_PACKAGES,
} from '../configs/java-config';

export class AppSyncModelJavaVisitor<
  TRawConfig extends RawAppSyncModelConfig = RawAppSyncModelConfig,
  TPluginConfig extends ParsedAppSyncModelConfig = ParsedAppSyncModelConfig
> extends AppSyncModelVisitor<TRawConfig, TPluginConfig> {
  protected additionalPackages: Set<string> = new Set();

  generate(): string {
    if (this._parsedConfig.generate === 'loader') {
      return this.generateClassLoader();
    }
    if (this.selectedTypeIsEnum()) {
      return this.generateEnums();
    }
    return this.generateClasses();
  }

  generateClassLoader(): string {
    const AMPLIFY_MODEL_VERSION = 'AMPLIFY_MODEL_VERSION';
    const result: string[] = [this.generatePackageName(), '', this.generateImportStatements(LOADER_IMPORT_PACKAGES)];
    result.push(
      transformComment(dedent` Contains the set of model classes that implement {@link Model}
    interface.`)
    );

    const loaderClassDeclaration = new JavaDeclarationBlock()
      .withName(LOADER_CLASS_NAME)
      .access('public')
      .final()
      .asKind('class')
      .implements(['ModelProvider']);

    // Schema version
    // private static final String AMPLIFY_MODELS_VERSION = "hash-code";
    loaderClassDeclaration.addClassMember(AMPLIFY_MODEL_VERSION, 'String', `"${this.computeVersion()}"`, [], 'private', {
      final: true,
      static: true,
    });

    // singleton instance
    // private static AmplifyCliGeneratedModelProvider amplifyCliGeneratedModelStoreInstance;
    loaderClassDeclaration.addClassMember('amplifyGeneratedModelInstance', LOADER_CLASS_NAME, '', [], 'private', { static: true });

    // private constructor for singleton
    loaderClassDeclaration.addClassMethod(LOADER_CLASS_NAME, null, '', [], [], 'private');

    // getInstance
    const getInstanceBody = dedent`
    if (amplifyGeneratedModelInstance == null) {
      amplifyGeneratedModelInstance = new ${LOADER_CLASS_NAME}();
    }
    return amplifyGeneratedModelInstance;`;
    loaderClassDeclaration.addClassMethod('getInstance', LOADER_CLASS_NAME, getInstanceBody, [], [], 'public', {
      static: true,
      synchronized: true,
    });

    // models method
    const modelsMethodDocString = dedent`
    Get a set of the model classes.

    @return a set of the model classes.`;

    const classList = Object.values(this.typeMap)
      .map(model => `${this.getModelName(model)}.class`)
      .join(', ');
    const modelsMethodImplementation = `final Set<Class<? extends Model>> modifiableSet = new HashSet<>(
      Arrays.<Class<? extends Model>>asList(${classList})
    );

    return Immutable.of(modifiableSet);
    `;
    loaderClassDeclaration.addClassMethod(
      'models',
      'Set<Class<? extends Model>>',
      modelsMethodImplementation,
      [],
      [],
      'public',
      {},
      ['Override'],
      undefined,
      modelsMethodDocString
    );

    // version method
    const versionMethodDocString = dedent`
    Get the version of the models.

    @return the version string of the models.
    `;
    loaderClassDeclaration.addClassMethod(
      'version',
      'String',
      `return ${AMPLIFY_MODEL_VERSION};`,
      [],
      [],
      'public',
      {},
      ['Override'],
      undefined,
      versionMethodDocString
    );

    result.push(loaderClassDeclaration.string);
    return result.join('\n');
  }
  generateEnums(): string {
    const result: string[] = [this.generatePackageName()];
    Object.entries(this.getSelectedEnums()).forEach(([name, enumValue]) => {
      const enumDeclaration = new JavaDeclarationBlock()
        .asKind('enum')
        .access('public')
        .withName(this.getEnumName(enumValue))
        .annotate(['SuppressWarnings("all")'])
        .withComment('Auto generated enum from GraphQL schema.');
      const body = Object.values(enumValue.values);
      enumDeclaration.withBlock(indentMultiline(body.join(',\n')));
      result.push(enumDeclaration.string);
    });
    return result.join('\n');
  }

  generateClasses(): string {
    const result: string[] = [];
    Object.entries(this.getSelectedModels()).forEach(([name, model]) => {
      const modelDeclaration = this.generateClass(model);
      result.push(...[modelDeclaration]);
    });
    const packageDeclaration = this.generatePackageHeader();
    return [packageDeclaration, ...result].join('\n');
  }

  generatePackageName(): string {
    return `package ${GENERATED_PACKAGE_NAME};`;
  }
  generateClass(model: CodeGenModel): string {
    const classDeclarationBlock = new JavaDeclarationBlock()
      .asKind('class')
      .access('public')
      .withName(this.getModelName(model))
      .implements(['Model'])
      .withComment(`This is an auto generated class representing the ${model.name} type in your schema.`)
      .final();

    const annotations = this.generateModelAnnotations(model);
    classDeclarationBlock.annotate(annotations);

    model.fields.forEach(field => this.generateQueryFields(field, classDeclarationBlock));
    model.fields.forEach(field => {
      this.generateField(field, classDeclarationBlock);
    });

    // step interface declarations
    this.generateStepBuilderInterfaces(model).forEach((builderInterface: JavaDeclarationBlock) => {
      classDeclarationBlock.nestedClass(builderInterface);
    });

    // builder
    this.generateBuilderClass(model, classDeclarationBlock);

    // getters
    this.generateGetters(model, classDeclarationBlock);

    // constructor
    this.generateConstructor(model, classDeclarationBlock);

    // equals
    this.generateEqualsMethod(model, classDeclarationBlock);
    // hash code
    this.generateHashCodeMethod(model, classDeclarationBlock);
    return classDeclarationBlock.string;
  }

  protected generatePackageHeader(): string {
    const imports = this.generateImportStatements([...Array.from(this.additionalPackages), '', ...CLASS_IMPORT_PACKAGES]);
    return [this.generatePackageName(), '', imports].join('\n');
  }

  /**
   * generate import statements.
   * @param packages
   *
   * @returns string
   */
  protected generateImportStatements(packages: string[]): string {
    return packages.map(pkg => (pkg ? `import ${pkg};` : '')).join('\n');
  }
  /**
   * Add query field used for construction of conditions by SyncEngine
   */
  protected generateQueryFields(field: CodeGenField, classDeclarationBlock: JavaDeclarationBlock): void {
    const queryFieldName = constantCase(field.name);
    classDeclarationBlock.addClassMember(queryFieldName, 'QueryField', `field("${this.getFieldName(field)}")`, [], 'public', {
      final: true,
      static: true,
    });
  }
  /**
   * Add fields as members of the class
   * @param field
   * @param classDeclarationBlock
   */
  protected generateField(field: CodeGenField, classDeclarationBlock: JavaDeclarationBlock): void {
    const annotations = this.generateFieldAnnotations(field);
    const fieldType = this.getNativeType(field);
    const fieldName = this.getFieldName(field);
    classDeclarationBlock.addClassMember(fieldName, fieldType, '', annotations, 'private', {
      final: true,
    });
  }

  protected generateStepBuilderInterfaces(model: CodeGenModel): JavaDeclarationBlock[] {
    const nonNullableFields = model.fields.filter(field => !field.isNullable);
    const nullableFields = model.fields.filter(field => field.isNullable);
    const nonIdFields = nonNullableFields.filter((field: CodeGenField) => !this.READ_ONLY_FIELDS.includes(field.name));
    const interfaces = nonIdFields.map((field, idx) => {
      const fieldName = this.getFieldName(field);
      const isLastField = nonIdFields.length - 1 === idx ? true : false;
      const returnType = isLastField ? 'Build' : nonIdFields[idx + 1].name;
      const interfaceName = this.getStepInterfaceName(field.name);
      const methodName = this.getStepFunctionName(field);
      const argumentType = this.getNativeType(field);
      const argumentName = this.getStepFunctionArgumentName(field);
      const interfaceDeclaration = new JavaDeclarationBlock()
        .asKind('interface')
        .withName(interfaceName)
        .access('public');
      interfaceDeclaration.withBlock(indent(`${this.getStepInterfaceName(returnType)} ${methodName}(${argumentType} ${argumentName});`));
      return interfaceDeclaration;
    });

    // Builder
    const builder = new JavaDeclarationBlock()
      .asKind('interface')
      .withName(this.getStepInterfaceName('Build'))
      .access('public');
    const builderBody = [];
    // build method
    builderBody.push(`${this.getModelName(model)} build();`);

    // id method. Special case as this can throw exception
    builderBody.push(`${this.getStepInterfaceName('Build')} id(String id) throws AmplifyException;`);

    nullableFields.forEach(field => {
      const fieldName = this.getFieldName(field);
      builderBody.push(`${this.getStepInterfaceName('Build')} ${fieldName}(${this.getNativeType(field)} ${fieldName});`);
    });

    builder.withBlock(indentMultiline(builderBody.join('\n')));
    return [...interfaces, builder];
  }

  /**
   * Generate the Builder class
   * @param model
   * @returns JavaDeclarationBlock
   */
  protected generateBuilderClass(model: CodeGenModel, classDeclaration: JavaDeclarationBlock): void {
    const nonNullableFields = model.fields.filter(field => !field.isNullable);
    const nullableFields = model.fields.filter(field => field.isNullable);
    const stepFields = nonNullableFields.filter((field: CodeGenField) => !this.READ_ONLY_FIELDS.includes(field.name));
    const stepInterfaces = stepFields.map((field: CodeGenField) => {
      return this.getStepInterfaceName(field.name);
    });

    const builderClassDeclaration = new JavaDeclarationBlock()
      .access('public')
      .static()
      .asKind('class')
      .withName('Builder')
      .implements([...stepInterfaces, this.getStepInterfaceName('Build')]);

    // Add private instance fields
    [...nonNullableFields, ...nullableFields].forEach((field: CodeGenField) => {
      const fieldName = this.getFieldName(field);
      builderClassDeclaration.addClassMember(fieldName, this.getNativeType(field), '', undefined, 'private');
    });

    // methods
    // builder()
    builderClassDeclaration.addClassMethod(
      'builder',
      this.getStepInterfaceName(stepFields[0].name),
      indentMultiline(`return new Builder();`),
      [],
      [],
      'public',
      { static: true },
      []
    );

    // build();
    const buildImplementation = [`String id = this.id != null ? this.id : UUID.randomUUID().toString();`, ''];
    const buildParams = model.fields.map(field => this.getFieldName(field)).join(',\n');
    buildImplementation.push(`return new ${this.getModelName(model)}(\n${indentMultiline(buildParams)});`);
    builderClassDeclaration.addClassMethod(
      'build',
      this.getModelName(model),
      indentMultiline(buildImplementation.join('\n')),
      undefined,
      [],
      'public',
      {},
      ['Override']
    );

    // non-nullable fields
    stepFields.forEach((field: CodeGenField, idx: number, fields) => {
      const isLastStep = idx === fields.length - 1;
      const fieldName = this.getFieldName(field);
      const methodName = this.getStepFunctionName(field);
      const returnType = isLastStep ? this.getStepInterfaceName('Build') : this.getStepInterfaceName(fields[idx + 1].name);
      const argumentType = this.getNativeType(field);
      const argumentName = this.getStepFunctionArgumentName(field);
      const body = [`Objects.requireNonNull(${fieldName});`, `this.${fieldName} = ${argumentName};`, `return this;`].join('\n');
      builderClassDeclaration.addClassMethod(
        methodName,
        returnType,
        indentMultiline(body),
        [{ name: argumentName, type: argumentType }],
        [],
        'public',
        {},
        ['Override']
      );
    });

    // nullable fields
    nullableFields.forEach((field: CodeGenField) => {
      const fieldName = this.getFieldName(field);
      const methodName = this.getStepFunctionName(field);
      const returnType = this.getStepInterfaceName('Build');
      const argumentType = this.getNativeType(field);
      const argumentName = this.getStepFunctionArgumentName(field);
      const body = [`this.${fieldName} = ${argumentName};`, `return this;`].join('\n');
      builderClassDeclaration.addClassMethod(
        methodName,
        returnType,
        indentMultiline(body),
        [{ name: argumentName, type: argumentType }],
        [],
        'public',
        {},
        ['Override']
      );
    });

    // Add id builder
    const idBuildStepBody = dedent`this.id = id;

    try {
        UUID.fromString(id); // Check that ID is in the UUID format - if not an exception is thrown
    } catch (Exception exception) {
        throw new AmplifyException("Model IDs must be unique in the format of UUID.",
                exception,
                "If you are creating a new object, leave ID blank and one will be auto generated for you. " +
                "Otherwise, if you are referencing an existing object, be sure you are getting the correct " +
                "id for it. It's also possible you are referring to an item created outside of Amplify." +
                "It is currently not supported.",
                false);
    }

    return this;`;

    const idComment = dedent`WARNING: Do not set ID when creating a new object. Leave this blank and one will be auto generated for you.
    This should only be set when referring to an already existing object.
    @param id id
    @return Current Builder instance, for fluent method chaining
    @throws AmplifyException Checks that ID is in the proper format`;

    builderClassDeclaration.addClassMethod(
      'id',
      this.getStepInterfaceName('Build'),
      indentMultiline(idBuildStepBody),
      [{ name: 'id', type: 'String' }],
      [],
      'public',
      {},
      [],
      ['AmplifyException'],
      idComment
    );
    classDeclaration.nestedClass(builderClassDeclaration);
  }

  /**
   * Generate getters for all the fields declared in the model. All the getter methods are added
   * to the declaration block passed
   * @param model
   * @param declarationsBlock
   */
  protected generateGetters(model: CodeGenModel, declarationsBlock: JavaDeclarationBlock): void {
    model.fields.forEach((field: CodeGenField) => {
      const fieldName = this.getFieldName(field);
      const returnType = this.getNativeType(field);
      const methodName = this.getFieldGetterName(field);
      const body = indent(`return ${fieldName};`);
      declarationsBlock.addClassMethod(methodName, returnType, body, undefined, undefined, 'public');
    });
  }

  /**
   * Generate Java field getter name
   * @param field codegen field
   */
  protected getFieldGetterName(field: CodeGenField): string {
    return `get${pascalCase(field.name)}`;
  }

  /**
   * generates the method name used in step builder
   * @param field
   */
  protected getStepFunctionName(field: CodeGenField): string {
    return camelCase(field.name);
  }

  /**
   * generates Step function argument
   * @param field
   */
  protected getStepFunctionArgumentName(field: CodeGenField): string {
    return camelCase(field.name);
  }

  /**
   * Generate constructor for the class
   * @param model CodeGenModel
   * @param declarationsBlock Class Declaration block to which constructor will be added
   */
  protected generateConstructor(model: CodeGenModel, declarationsBlock: JavaDeclarationBlock): void {
    const name = this.getModelName(model);
    const body = model.fields
      .map((field: CodeGenField) => {
        const fieldName = this.getFieldName(field);
        return `this.${fieldName} = ${fieldName};`;
      })
      .join('\n');

    const constructorArguments = model.fields.map(field => {
      return { name: this.getFieldName(field), type: this.getNativeType(field) };
    });
    declarationsBlock.addClassMethod(name, null, body, constructorArguments, undefined, 'private');
  }

  protected getNativeType(field: CodeGenField): string {
    const nativeType = super.getNativeType(field);
    if (nativeType.includes('.')) {
      const classSplit = nativeType.split('.');
      this.additionalPackages.add(nativeType);
      return classSplit[classSplit.length - 1];
    }
    return nativeType;
  }

  /**
   * Generate code for equals method
   * @param model
   * @param declarationBlock
   */
  protected generateEqualsMethod(model: CodeGenModel, declarationBlock: JavaDeclarationBlock): void {
    const paramName = 'obj';
    const className = this.getModelName(model);
    const instanceName = camelCase(model.name);

    const body = [
      `if (this == ${paramName}) {`,
      '  return true;',
      `} else if(${paramName} == null || getClass() != ${paramName}.getClass()) {`,
      '  return false;',
      '} else {',
    ];

    body.push(`${className} ${instanceName} = (${className}) ${paramName};`);
    const propCheck = indentMultiline(
      model.fields
        .map(field => {
          const getterName = this.getFieldGetterName(field);
          return `ObjectsCompat.equals(${getterName}(), ${instanceName}.${getterName}())`;
        })
        .join(' &&\n'),
      4
    ).trimStart();

    body.push(`return ${propCheck};`);
    body.push('}');

    declarationBlock.addClassMethod(
      'equals',
      'boolean',
      indentMultiline(body.join('\n')),
      [{ name: paramName, type: 'Object' }],
      [],
      'public',
      {},
      ['Override']
    );
  }

  protected generateHashCodeMethod(model: CodeGenModel, declarationBlock: JavaDeclarationBlock): void {
    const body = [
      'return new StringBuilder()',
      ...model.fields.map(field => `.append(${this.getFieldGetterName(field)}())`),
      '.hashCode();',
    ].join('\n');
    declarationBlock.addClassMethod('hashCode', 'int', indentMultiline(body).trimLeft(), [], [], 'public', {}, ['Override']);
  }

  /**
   * Generate the name of the step builder interface
   * @param nextFieldName: string
   * @returns string
   */
  private getStepInterfaceName(nextFieldName: string): string {
    return `I${pascalCase(nextFieldName)}Step`;
  }

  protected generateModelAnnotations(model: CodeGenModel): string[] {
    const annotations: string[] = model.directives.map(directive => {
      switch (directive.name) {
        case 'model':
          return `ModelConfig(targetName = "${model.name}")`;
          break;
        case 'key':
          const args: string[] = [];
          args.push(`name = "${directive.arguments.name}"`);
          args.push(`fields = {${(directive.arguments.fields as string[]).map((f: string) => `"${f}"`).join(',')}}`);
          return `Index(${args.join(', ')})`;

        default:
          break;
      }
      return '';
    });
    return ['SuppressWarnings("all")', ...annotations].filter(annotation => annotation);
  }

  protected generateFieldAnnotations(field: CodeGenField): string[] {
    const annotations: string[] = [];
    const annotationArgs: string[] = [
      `targetName="${field.name}"`,
      `targetType="${field.type}"`,
      !field.isNullable ? 'isRequired = true' : '',
    ].filter(arg => arg);

    annotations.push(`ModelField(${annotationArgs.join(', ')})`);

    field.directives.forEach(annotation => {
      switch (annotation.name) {
        case 'connection':
          const connectionArgs: string[] = [];
          Object.keys(annotation.arguments).forEach(argName => {
            if (['name', 'keyField', 'sortField', 'keyName'].includes(argName)) {
              connectionArgs.push(`${argName} = "${annotation.arguments[argName]}"`);
            }
          });
          if (annotation.arguments.limit) {
            connectionArgs.push(`limit = ${annotation.arguments.limit}`);
          }
          if (annotation.arguments.fields && isArray(annotation.arguments.fields)) {
            const fieldArgs = (annotation.arguments.fields as string[]).map(f => `"${f}"`).join(', ');
            connectionArgs.push(`fields = {{${fieldArgs}}`);
          }

          if (connectionArgs.length) {
            annotations.push(`Connection(${connectionArgs.join(', ')})`);
          }
      }
    });
    return annotations;
  }
}
