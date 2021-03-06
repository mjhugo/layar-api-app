import { Injectable } from '@angular/core';
import { Observable, of, Subject, throwError } from 'rxjs';
import { finalize, mergeMap, tap, timeout } from 'rxjs/operators';
import { HttpClient, HttpResponse } from '@angular/common/http';
import { environment } from 'src/environments/environment';
import { AuthStrategy, Credentials } from './auth.strategy';
import { AuthStrategyRecaptcha } from './auth.strategy.recaptcha';
import { AuthStrategyOauth } from './auth.strategy.oauth';
import { AuthStrategyUser } from './auth.strategy.user';

const TIMEOUT_PARAM = 'TIMEOUT_MS';
const DEFAULT_TIMEOUT_MS = 60 * 5 * 1000; // 5 min

export const IgnoreObserver = '__IgnoreObserver__';

export interface Request {
    method: string; 
    url: string; 
    body: any;
    headers: { [header: string]: string | string[] };
    params: { [param: string]: string | string[] };
}

export interface RequestObserver {
    version: number,
    onRequest(request: Request, response: HttpResponse<any>, error: any, version: number);
}

interface PendingRequest {
    method: string;
    path: string;
    data: any;
    headers: { [key: string]: string };
    params: { [key: string]: string | Array<string> };
}

class PendingSubject extends Subject<HttpResponse<any>> {
    constructor(public request: PendingRequest) { super(); }
}

@Injectable()
export class AuthService {
    public observer: RequestObserver;

    private readonly baseUrl: string = (environment.apiUrl).replace('%WORKSPACE_URL%', window.location.hostname);
    private strategy: AuthStrategy;
    private credentials: Credentials;
    private credentialsSubject: Subject<Credentials>;

    constructor(private http: HttpClient) {
        const AuthStrategies = {
            'recaptcha': () => new AuthStrategyRecaptcha(this.http),
            'oauth': () => new AuthStrategyOauth(this.request.bind(this)),
            'user': () => new AuthStrategyUser(this.request.bind(this)),
        }
        this.strategy = AuthStrategies[environment.authStrategy] && AuthStrategies[environment.authStrategy]();
    }

    private getCredentials(): Observable<Credentials> {
        if (!this.credentialsSubject) {
            this.credentialsSubject = new Subject<Credentials>();
            this.strategy.getCredentials().pipe(tap(credentials => {
                this.credentials = credentials;
            }), finalize(() => {
                this.credentialsSubject = undefined;
            })).subscribe(this.credentialsSubject);
        }

        return this.credentialsSubject;
    }

    private setAuthHeader(headers: { [key: string]: string | Array<string> }): Observable<any> {
        if (headers['Authorization']) { 
            return of(true); 
        }

        const now = Date.now();
        if (this.credentials && ((this.credentials.expiration || 0) <= 0 || this.credentials.expiration > now)) { 
            headers['Authorization'] = `Bearer ${this.credentials.accessToken}`;
            return of(true);
        }

        return this.getCredentials().pipe(tap(credentials => {
            headers['Authorization'] = `Bearer ${credentials.accessToken}`;
        }));
    }

    private request(method: string, path: string, params_: { [key: string]: string | Array<string> }, headers_: { [key: string]: string }, data: any): Observable<HttpResponse<any>> {
        let headers: { [key: string]: string | Array<string> } = { ...(headers_ || {}) };

        if (!!data && !headers['Content-Type']) { headers['Content-Type'] = 'application/json'; }
        if (!headers['Accept']) { headers['Accept'] = 'application/json'; }
        if (!headers['X-Vyasa-Client']) { headers['X-Vyasa-Client'] = 'layar'; }

        const ignoreObserver: boolean = !!headers[IgnoreObserver] || !!headers_['Authorization'];
        if (headers[IgnoreObserver]) { delete headers[IgnoreObserver]; }

        let responseType: 'blob' | 'json' | 'text' = headers['Accept'] === 'application/octet-stream' ? 
            'blob' : headers['Accept'] === 'application/json' ? 'json' : 'text';

        let timeoutMs = !!params_[TIMEOUT_PARAM] ? +params_[TIMEOUT_PARAM] : DEFAULT_TIMEOUT_MS;

        // Workaround https://github.com/angular/angular/issues/11058
        let params: { [key: string]: string | Array<string> } = { ...(params_ || {}) };
        for (let key in params) {
            if (params[key] === undefined) {
                delete params[key];
            } else {
                let array: Array<any> = Array.isArray(params[key]) ? params[key] as Array<string> : [params[key] as string];
                array = array.map(o => {
                    if (!((o as any) instanceof Date) || !o.getTime()) { return o; }
                    return o.toISOString(); // serialize dates in a specific way
                }).filter(o => o !== undefined);
                if (!array.length) {
                    delete params[key];
                } else {
                    params[key] = array.length === 1 ? array[0] : array;
                }
            }
        }
        delete params[TIMEOUT_PARAM];

        let url = `${this.baseUrl}${path}`;

        const subject = new Subject<HttpResponse<any>>();
        const request: Request = { method, url, body: data, headers, params };
        const version = this.observer?.version || 0;
        this.setAuthHeader(headers).pipe(mergeMap(() => {
            return this.http.request(method, url, {
                body: data,
                headers: headers,
                params: params,
                responseType: responseType,
                observe: 'response',
            });
        }), timeout(timeoutMs)).subscribe(response => {
            !ignoreObserver && this.observer?.onRequest(request, response, undefined, version);
            subject.next(response);
            subject.complete();
        }, error => {
            const pending: PendingRequest = { method, path, params: params_, headers: headers_, data };
            if (!this.shouldAttemptRefresh(error, pending)) {
                !ignoreObserver && this.observer?.onRequest(request, undefined, error, version);
                subject.error(error);
                return;
            } else {
                this.processRefresh(pending).subscribe(subject);
            }
        });

        return subject;
    }

    public GET(path: string, params: { [key: string]: string | Array<string> }, headers: { [key: string]: string } = {}, data: any = undefined): Observable<HttpResponse<any>> {
        return this.request('GET', `/layar${path}`, params, headers, data);
    }

    public POST(path: string, params: { [key: string]: string | Array<string> }, headers: { [key: string]: string } = {}, data: any = undefined): Observable<HttpResponse<any>> {
        return this.request('POST', `/layar${path}`, params, headers, data);
    }

    public PUT(path: string, params: { [key: string]: string | Array<string> }, headers: { [key: string]: string } = {}, data: any = undefined): Observable<HttpResponse<any>> {
        return this.request('PUT', `/layar${path}`, params, headers, data);
    }

    public PATCH(path: string, params: { [key: string]: string | Array<string> }, headers: { [key: string]: string } = {}, data: any = undefined): Observable<HttpResponse<any>> {
        return this.request('PATCH', `/layar${path}`, params, headers, data);
    }

    public DELETE(path: string, params: { [key: string]: string | Array<string> }, headers: { [key: string]: string } = {}, data: any = undefined): Observable<HttpResponse<any>> {
        return this.request('DELETE', path, params, headers, data);
    }

    private shouldAttemptRefresh(response: HttpResponse<any>, pending: PendingRequest): boolean {
        if (pending.headers['Authorization']) {
            return false;
        } else if (!this.credentials?.refreshToken || !this.strategy.refreshCredentials) {
            return false;
        } 

        let json = undefined;
        try { json = response && ((response as any).error || response.body); } catch (error) { }
        const error = json && json.error && typeof json.error === 'string' && json.error.toLowerCase() || '';

        if (error.indexOf('payment_required') >= 0 || response.status == 402) {
            return false;
        } else if (error.indexOf('invalid_token') < 0 && error.indexOf('unauthorized') < 0) {
            return false;
        }

        return true;
    }

    private pending: Array<PendingSubject> = undefined;
    private processRefresh(pending: PendingRequest): Observable<HttpResponse<any>> {
        const subject = new PendingSubject(pending);

        if (this.pending) {
            this.pending.push(subject);
            return subject;
        }

        this.pending = new Array<PendingSubject>();
        this.pending.push(subject);

        this.strategy.refreshCredentials(this.credentials).pipe(finalize(() => {
            const pending = this.pending;
            const credentials = this.credentials;

            this.pending = undefined;
            
            for (const subject of pending) {
                if (credentials?.accessToken) {
                    const request = subject.request;
                    this.request(request.method, request.path, request.params, request.headers, request.data).subscribe(subject);
                } else {
                    throwError({ statusText: 'Invalid access token.', status: 401 }).subscribe(subject);
                }
            }
        })).subscribe(credentials => {
            this.credentials = credentials;
        }, error => {
            this.credentials = undefined;
        });

        return subject;
    }
}
