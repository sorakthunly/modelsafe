/** Contains the model classes and decorators. */
import * as _ from 'lodash';

import { DATE } from './attribute';
import { isLazyLoad, HAS_MANY, BELONGS_TO_MANY } from './association';
import { getAttributes, getAttributeValidations, getAssociations } from './metadata';
import { ModelErrors, ValidationError, PropertyValidationError } from './validation';

/** Options for constructing a model instance. */
export interface ModelConstructorOptions {
  /**
   * Whether the model constructor should merge all default values
   * onto the model instance.
   */
  defaults: boolean;
}

/** Options for serializing a JSON object from a model instance. */
// tslint:disable-next-line:no-empty-interface
export interface SerializeOptions {
  /** Whether to serialize associations recursively. */
  associations?: boolean;

  /** The depth of associations to recursively serialize. */
  depth?: number;
}

/** Options for deserializing a JSON object to a model instance. */
export interface DeserializeOptions {
  /** Whether to serialize associations recursively. */
  associations?: boolean;

  /** The depth of associations to recursively serialize. */
  depth?: number;

  /** Whether to run validations to ensure the JSON data is valid. */
  validate?: boolean;
}

/** Options for validating a model instance. */
export interface ValidationOptions {
  /**
   * Whether to run validations that check whether required attributes are set.
   * This can be turned off to support partial validations.
   */
  required?: boolean;
}

/**
 * The abstract model class.
 * This should be extended by all database models.
 * Models are designed to be database generic,
 * which means you could have multiple database connections
 * and the model could be defined and queried on them separately.
 */
export abstract class Model {
  /**
   * Construct a model instance, with optional initial data.
   *
   * @param data    Any initial data for the instance.
   *                This isn't typed because we don't
   *                have knowledge of the child class here.
   * @param options Any extra options for the model construction.
   */
  constructor(data?: object, options?: Partial<ModelConstructorOptions>) {
    options = {
      defaults: true,

      ... options
    };

    // Merge default values on the model.
    if (options.defaults) {
      let attrs = getAttributes(this.constructor);

      for (let key of Object.keys(attrs)) {
        let attr = attrs[key];

        if (typeof (attr.defaultValue) !== 'undefined') {
          this[key] = isLazyLoad(attr.defaultValue) ?
            (attr.defaultValue as () => ModelConstructor<any>)() :
            attr.defaultValue;
        }
      }
    }

    // Merge user-provided values onto the instance.
    _.merge(this, data);
  }

  /**
   * De-serializes a JSON object into a model instance.
   * This will pick the properties that have
   * been decorated on the model and throw away everything else.
   *
   * On top of this the underlying types of the data will be checked
   * to ensure they confirm to their decorated types and decorated validations
   * will also run. This behaviour can be disabled by turning the `validate`
   * option to `false`.
   *
   * Default values will not be set on the deserialized data.
   *
   * @param data    The JSON data to deserialize.
   * @param options Any extra options to use for deserialization.
   * @returns       A promise that resolves with a deserialized model,
   *                otherwise rejecting with a validation error if validations were enabled.
   */
  static async deserialize<T extends Model>(data: object, options?: DeserializeOptions): Promise<T> {
    // Validate by default
    options = {
      validate: true,
      associations: true,
      depth: 1,

      ... options
    };

    // Deserialize for any associations deserialized under this model
    let assocOptions = {
      ... options,

      depth: options.depth - 1
    };

    // Force it to be a plain object in case it isn't already.
    // This allows weird behaviour like passing in an existing model
    // class instance to be supported.
    if (!_.isPlainObject(data)) {
      data = _.toPlainObject(data);
    } else {
      data = _.clone(data);
    }

    // Don't merge default values on during construction because we want the data 'as-is'
    let attrs = getAttributes(this);
    let assocs = getAssociations(this);
    let instance = new (this as ModelConstructor<T>)(_.pick(data, Object.keys(attrs)), { defaults: false }) as T;

    // Convert date ISO string into Date object
    Object.keys(attrs).forEach(key => {
      if (attrs[key].type.type === DATE.type && typeof (instance[key]) === 'string') {
        instance[key] = new Date(instance[key]);
      }
    });

    if (assocOptions.associations) {
      // Call deserialization methods for associations to populate deserialized association data
      for (let key of Object.keys(assocs)) {
        let assoc = assocs[key];
        let value = data[key];
        let target = assoc.target;

        // Don't attempt to deserialize association values that are nil.
        if (_.isNil(value)) {
          continue;
        }

        if (isLazyLoad(target)) {
          target = (target as () => ModelConstructor<any>)();
        }

        // We can't deserialize undefined model constructors
        if (!target) {
          throw new Error(`Cannot deserialize because association ${key} is not defined`);
        }

        if (assocOptions.depth >= 0) {
          // If it's an array like relationship and the value is an array, deserialize each element
          if (assoc.type === HAS_MANY || assoc.type === BELONGS_TO_MANY) {
            // Only deserialize these types if the value is array-like.
            // Fallback to an empty array if the value is invalid.
            if (!_.isArray(value)) {
              instance[key] = [];

              continue;
            }

            instance[key] = await Promise.all(_.map(value, async (item) => {
              return (target as ModelConstructor<any>).deserialize(item, assocOptions);
            }));
          } else {
            instance[key] = await (target as ModelConstructor<any>).deserialize(value, assocOptions);
          }
        }
      }
    }

    // Throw validation errors if required in order to ensure valid instances only
    if (options.validate) {
      await instance.validate();
    }

    return instance;
  }

  /**
   * Serializes a model instance into a JSON object.
   *
   * This will pick the properties that have been decorated on the model and throw
   * away everything else.
   *
   * @param instance The instance to serialize to JSON.
   * @param _options Any extra options to use for serialization.
   * @returns        A promise that resolves with a serialized model, otherwise rejecting with an error.
   */
  static async serialize<T extends Model>(instance: T, options?: SerializeOptions): Promise<object> {
    // Default options
    options = {
      associations: true,
      depth: 1,

      ... options
    };

    // Serialize for any associations serialized under this model
    let assocOptions = {
      ... options,

      depth: options.depth - 1
    };

    let attrs = getAttributes(this);
    let assocs = getAssociations(this);
    let result = _.pick(_.toPlainObject(instance), Object.keys(attrs));

    if (assocOptions.associations) {
      // Call serialization methods for associations to populate serialized association data
      for (let key of Object.keys(assocs)) {
        let assoc = assocs[key];
        let value = instance[key];
        let target = assoc.target;

        // Don't attempt to serialize association values that are nil.
        if (_.isNil(value)) {
          continue;
        }

        if (isLazyLoad(target)) {
          target = (target as () => ModelConstructor<any>)();
        }

        // We can't serialize undefined model constructors
        if (!target) {
          throw new Error(`Cannot serialize because association ${key} is not defined`);
        }

        if (assocOptions.depth >= 0) {
          // If it's an array like relationship and the value is an array, serialize each element.
          if (assoc.type === HAS_MANY || assoc.type === BELONGS_TO_MANY) {
            // Only deserialize these types if the value is array-like.
            // Fallback to an empty array if the value is invalid.
            if (!_.isArray(value)) {
              result[key] = [];

              continue;
            }

            // FIXME: Any cast required because we don't know the target model type in this instance
            result[key] = await Promise.all(_.map(value, async (item) => {
              return (target as ModelConstructor<any>).serialize(item as any, assocOptions);
            }));
          } else {
            result[key] = await (target as ModelConstructor<any>).serialize(value, assocOptions);
          }
        }
      }
    }

    return result;
  }

  /**
   * Serialize a model instance into a JSON object.
   *
   * This method should not be overridden - the static serialize function should be changed.
   * See the static serialize method for more information.
   *
   *
   * @param options Any extra options to use for serialization.
   * @returns       A promise that resolves with a serialized model, otherwise rejecting with an error.
   */
  async serialize(options?: SerializeOptions): Promise<object> {
    return (this.constructor as typeof Model).serialize(this, options);
  }

  /**
   * Check that a model instance passes its validations.
   * This will check that the instance's data has values that
   * match the attribute type's expected formats and also run
   * any additional decorated attribute validations.
   *
   * This throws an error if there was a validation failure, otherwise
   * resolving with nothing in the case of success.
   *
   * @param options Any extra validation options to validate with.
   * @returns A promise that resolves successfully or
   *          rejects with a `ValidationError` if there was a validation error
   */
  async validate(options?: ValidationOptions): Promise<void> {
    options = {
      required: true,

      ... options
    };

    let attrs = getAttributes(this.constructor);
    let errors: ModelErrors<any> = {};

    // Validate all attributes
    for (let key of Object.keys(attrs)) {
      let attr = attrs[key];
      let value = this[key];
      let attrErrors = [];

      // The decorated validations, i.e. extra validations that have been provided
      let validations = getAttributeValidations(this.constructor, key);

      // Coerce non property validation errors into an unknown validation error
      let coerceError = (err: Error): PropertyValidationError => {
        if (err instanceof PropertyValidationError) {
          return err;
        }

        return new PropertyValidationError('unknown', err.message);
      };

      if (_.isNil(value)) {
        if (attr.optional || !options.required) {
          // There's no value and the field is optional.
          // Don't perform any validations on this attribute.
          continue;
        } else {
          // There's no value and the field is required. Show an error.
          // Validate that non-optional attributes exist on the instance.

          attrErrors.push({
            type: 'attribute.required',
            message: 'Value is required'
          });
        }
      }

      // Run the attribute type validation if available
      if (typeof (attr.type.validate) === 'function') {
        if (_.isNil(value) && attr.defaultValue) {
          value = isLazyLoad(attr.defaultValue) ?
            (attr.defaultValue as () => ModelConstructor<any>)() :
            attr.defaultValue;
        }

        try {
          await attr.type.validate(key, value);
        } catch (err) {
          err = coerceError(err);

          attrErrors.push({
            type: err.type,
            message: err.message
          });
        }
      }

      // We try the decorated attribute validations separately, since we want to capture
      // both attribute type validations and decorated validations at the same time.
      // We also want all validations to trigger, so we try/catch inside the for loop.
      for (let validation of validations) {
        try {
          await validation.cb(key, value, validation.options);
        } catch (err) {
          err = coerceError(err);

          attrErrors.push({
            type: err.type,
            message: err.message
          });
        }
      }

      if (attrErrors.length < 1) {
        // Don't generate error messages if there was no errors.
        continue;
      }

      errors[key] = (errors[key] || []).concat(attrErrors);
    }

    // Only throw if there was at least one error, otherwise validation was successful
    if (Object.keys(errors).length > 0) {
      throw new ValidationError(this.constructor as ModelConstructor<any>, 'Validation error', errors);
    }
  }
}

/** A value that is both a model class value and something that can construct a model. */
export type ModelConstructor<T extends Model> = typeof Model & { new(): T };

/** The options that can be defined for a model. */
export interface ModelOptions {
  /** The name of the model. */
  name?: string;
}
